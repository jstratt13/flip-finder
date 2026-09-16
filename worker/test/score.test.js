import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreListing, passesGates } from '../src/score.js';
import { assessCondition } from '../src/condition.js';
import { confidenceFor, CONFIDENCE } from '../src/config.js';

const comp = { retail_price: 400, active_median: 250, n_active: 10, n_new: 6 };
const match = { match_score: 0.9 };

test('condition: damage language outranks optimistic language', () => {
  const c = assessCondition({
    title: 'iPhone 13',
    description: 'Like new, but the screen is cracked',
  });
  assert.equal(c.band, 'fair');
});

test('condition: qualified wear beats the generic "used" match', () => {
  // "barely used" also matches /\bused\b/; the specific claim must win.
  assert.equal(assessCondition({ title: 'PS5 Slim - like new, barely used' }).band, 'like_new');
  assert.equal(assessCondition({ title: 'Drill, never used, still sealed' }).band, 'new');
  assert.equal(assessCondition({ title: 'Couch, heavily used' }).band, 'fair');
  assert.equal(assessCondition({ title: 'Bike, gently used' }).band, 'good');
  assert.equal(assessCondition({ title: 'Monitor, used' }).band, 'good');
});

test('condition: a grade claim about an accessory does not grade the item', () => {
  // Real Facebook listing: the amp is new, the subs are not.
  assert.equal(assessCondition({ title: '2 (12) kicker subs with brand new amp' }).band, 'unknown');
  assert.equal(assessCondition({ title: 'Drill kit w/ brand new battery' }).band, 'unknown');
  assert.equal(assessCondition({ title: 'iPhone 13 includes a new case' }).band, 'unknown');

  // The claim still lands when it's about the item itself.
  assert.equal(assessCondition({ title: 'Brand new kicker amp' }).band, 'new');
});

test('condition: damage counts even when it sits on an included part', () => {
  const c = assessCondition({ title: 'Camera with cracked lens filter' });
  assert.equal(c.band, 'fair');
});

test('condition: damage still caps a glowing grade claim', () => {
  const c = assessCondition({ title: 'Mint condition iPad, small crack in corner' });
  assert.equal(c.band, 'fair');
});

test('condition: bare damage words match, not just their -ed forms', () => {
  for (const word of ['crack', 'cracked', 'dent', 'dented', 'stain', 'stained', 'chip', 'chipped']) {
    assert.equal(
      assessCondition({ title: `Table with a ${word} on the top` }).band,
      'fair',
      `"${word}" should register as damage`
    );
  }
});

test('condition: structured field is used when present', () => {
  const c = assessCondition({ title: 'Sonos amp', condition_raw: 'Used - Like New' });
  assert.equal(c.band, 'like_new');
});

test('condition: no signal yields low-confidence unknown', () => {
  const c = assessCondition({ title: 'Desk', description: '' });
  assert.equal(c.band, 'unknown');
  assert.ok(c.confidence < 0.3);
});

test('pickup listing: profit nets out drive cost and passes gates', () => {
  const condition = assessCondition({ title: 'X', description: 'good condition' });
  const s = scoreListing({
    listing: { id: 'craigslist:1', price: 100, acquisition_mode: 'pickup', distance_mi: 10 },
    comp: { ...comp, active_median: 400 }, condition, match,
  });

  // A "good condition" item is priced off used comps alone: 400 * 0.8 = 320.
  // The new-condition median belongs to a different condition of the item.
  assert.ok(Math.abs(s.anchor_value - 320) < 0.01, `anchor was ${s.anchor_value}`);
  assert.equal(s.anchor_source, 'active');
  // acquisition = 100 + (10mi round trip * 0.35) = 107
  assert.ok(Math.abs(s.acquisition_cost - 107) < 0.01);
  assert.ok(s.profit > 0);
  assert.equal(passesGates(s), true);
});

test('shipped listing: takes freight cost, never a distance penalty', () => {
  const condition = assessCondition({ title: 'X', description: 'good condition' });
  const base = { id: 'ebay:1', price: 100 };

  const shipped = scoreListing({
    listing: { ...base, acquisition_mode: 'shipped', inbound_ship: 12, distance_mi: 2000 },
    comp, condition, match,
  });
  const local = scoreListing({
    listing: { ...base, acquisition_mode: 'pickup', distance_mi: 0 },
    comp, condition, match,
  });

  // A 2000-mile shipped item is penalised only by its freight, not its distance.
  assert.equal(shipped.acquisition_cost, 112);
  assert.equal(local.acquisition_cost, 100);
  assert.ok(shipped.profit > 0);
});

test('venue blend sits between the two single-venue nets', () => {
  const condition = assessCondition({ title: 'X', description: 'good condition' });
  const s = scoreListing({
    listing: { id: 'x:1', price: 100, acquisition_mode: 'pickup', distance_mi: 5 },
    comp, condition, match,
  });

  // FB nets more per unit (no fees/shipping) but realises a lower gross price.
  assert.ok(s.est_net_fb > s.est_net_ebay);
  assert.ok(s.est_net_blended < s.est_net_fb);
  assert.ok(s.est_net_blended > s.est_net_ebay);
});

test('no comp data means no score rather than a fabricated one', () => {
  const s = scoreListing({
    listing: { id: 'x:2', price: 50, acquisition_mode: 'pickup', distance_mi: 1 },
    comp: null,
    condition: assessCondition({ title: 'X' }),
    match,
  });
  assert.equal(s.score, null);
  assert.equal(passesGates(s), false);
});

test('confidence compresses rather than compounding cubically', () => {
  // Three identical inputs should yield that input, not its cube.
  const c = confidenceFor({ matchScore: 0.7, nComps: 5.6, conditionConfidence: 0.7 });
  assert.ok(Math.abs(c - 0.7) < 0.01, `expected ~0.7, got ${c}`);
});

test('confidence still punishes a single weak link', () => {
  const strong = confidenceFor({ matchScore: 0.9, nComps: 12, conditionConfidence: 0.9 });
  const weakMatch = confidenceFor({ matchScore: 0.3, nComps: 12, conditionConfidence: 0.9 });
  assert.ok(weakMatch < strong * 0.8, 'a bad product match must still hurt');
  assert.equal(confidenceFor({ matchScore: 0, nComps: 12, conditionConfidence: 0.9 }), 0);
});

test('confidence weights are tunable per signal', () => {
  const base = confidenceFor({ matchScore: 0.9, nComps: 12, conditionConfidence: 0.2 });
  CONFIDENCE.condition_weight = 0.25;
  const downweighted = confidenceFor({ matchScore: 0.9, nComps: 12, conditionConfidence: 0.2 });
  CONFIDENCE.condition_weight = 1.0;
  assert.ok(downweighted > base, 'downweighting a weak signal should raise confidence');
});

test('low-confidence match cannot reach the top of the ranking', () => {
  const condition = assessCondition({ title: 'X', description: 'good condition' });
  const weak = scoreListing({
    listing: { id: 'x:3', price: 20, acquisition_mode: 'pickup', distance_mi: 1 },
    comp, condition, match: { match_score: 0.1 },
  });
  assert.equal(passesGates(weak), false);
});

// Resale comps are kept on both sides; the item's own condition picks the side.
test('a new or like-new listing is priced against new-condition comps', () => {
  const listing = { id: 'craigslist:2', price: 100, acquisition_mode: 'pickup', distance_mi: 10 };
  const sealed = scoreListing({
    listing, comp, match,
    condition: assessCondition({ title: 'X', description: 'brand new, sealed in box' }),
  });
  // 400 * 0.8, from the new-condition listings — not the used median.
  assert.equal(sealed.anchor_source, 'retail');
  assert.ok(Math.abs(sealed.anchor_value - 320) < 0.01, `anchor was ${sealed.anchor_value}`);

  // Unknown condition keeps the conservative side.
  const unknown = scoreListing({ listing, comp, match, condition: null });
  assert.equal(unknown.anchor_source, 'active');
  assert.ok(Math.abs(unknown.anchor_value - 200) < 0.01);
});

test('new-condition comps are only used when there are enough of them', () => {
  const thinNew = { ...comp, n_new: 2 };
  const s = scoreListing({
    listing: { id: 'craigslist:3', price: 100, acquisition_mode: 'pickup', distance_mi: 10 },
    comp: thinNew, match,
    condition: assessCondition({ title: 'X', description: 'brand new, sealed in box' }),
  });
  assert.equal(s.anchor_source, 'active');
});

test('one or two resale listings is not a market', () => {
  for (const n of [0, 1, 2]) {
    const s = scoreListing({
      listing: { id: `craigslist:9${n}`, price: 100, acquisition_mode: 'pickup', distance_mi: 10 },
      comp: { retail_price: 400, active_median: 250, n_active: n, n_new: 0 },
      match,
      condition: assessCondition({ title: 'X', description: 'good condition' }),
    });
    assert.equal(s.anchor_value, null, `n_active ${n} should not produce a value`);
    assert.equal(s.score, null);
  }
});
