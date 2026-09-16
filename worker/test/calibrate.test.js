import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrate } from '../src/calibrate.js';

// A closed flip. `ratio` scales what actually came back against what the model
// expected for that venue, which is the signal calibration is built on.
function sale({ venue = 'facebook', ratio = 1, predicted = 100, actual, band = 'good', category = 'electronics', id = 1 }) {
  const expectedNet = 200;
  const realised = expectedNet * ratio;
  return {
    sale_id: id,
    venue,
    sale_price: realised,
    fees_paid: 0,
    shipping_paid: 0,
    condition_band: band,
    category,
    predicted_profit: predicted,
    actual_profit: actual ?? predicted,
    est_net_fb: venue === 'facebook' ? expectedNet : null,
    est_net_ebay: venue === 'ebay' ? expectedNet : null,
  };
}

const many = (n, opts) => Array.from({ length: n }, (_, i) => sale({ ...opts, id: i + 1 }));

test('withholds judgement until there is enough history', () => {
  const c = calibrate(many(3, {}));
  assert.equal(c.ready, false);
  assert.equal(c.sales_with_prediction, 3);
  assert.equal(c.min_sales_for_suggestions, 8);
});

test('items bought before they were ever scored are counted but not compared', () => {
  const rows = [
    ...many(2, {}),
    { sale_id: 99, venue: 'facebook', sale_price: 100, predicted_profit: null, actual_profit: 40 },
  ];
  const c = calibrate(rows);
  assert.equal(c.sales_recorded, 3);
  assert.equal(c.sales_with_prediction, 2);
});

test('names which way the model is wrong, not just how far', () => {
  const optimistic = calibrate(many(10, { predicted: 100, actual: 60 }));
  assert.equal(optimistic.accuracy.bias, 'optimistic');
  assert.equal(optimistic.accuracy.median_profit_error, -40);

  const conservative = calibrate(many(10, { predicted: 100, actual: 140 }));
  assert.equal(conservative.accuracy.bias, 'conservative');

  const good = calibrate(many(10, { predicted: 100, actual: 100 }));
  assert.equal(good.accuracy.bias, 'balanced');
});

test('measures the real venue mix against the assumed one', () => {
  const rows = [...many(6, { venue: 'facebook' }), ...many(4, { venue: 'ebay' })];
  const c = calibrate(rows);

  const fb = c.venue_mix.find((v) => v.venue === 'facebook');
  assert.equal(fb.sales, 6);
  assert.ok(Math.abs(fb.measured_share - 0.6) < 0.001);
  // Everything is assumed to sell on Facebook now; measured share is what says
  // whether that holds.
  assert.ok(Math.abs(fb.configured_share - 1.0) < 0.001);
});

test('suggests a price factor from what venues actually returned', () => {
  // Facebook returned 10% less than expected across ten sales.
  const c = calibrate(many(10, { venue: 'facebook', ratio: 0.9 }));
  const fb = c.venue_accuracy.find((v) => v.venue === 'facebook');

  assert.equal(fb.sales, 10);
  assert.ok(Math.abs(fb.median_ratio - 0.9) < 0.001);
  // 0.9 current × 0.9 observed = 0.81
  assert.ok(Math.abs(fb.suggested_price_factor - 0.81) < 0.001);
});

test('a thin group reports its ratio but suggests nothing', () => {
  const c = calibrate([...many(8, { venue: 'facebook' }), ...many(2, { venue: 'ebay', ratio: 0.5, id: 50 })]);
  const ebay = c.venue_accuracy.find((v) => v.venue === 'ebay');

  assert.equal(ebay.sales, 2);
  assert.ok(ebay.median_ratio != null, 'should still report what it saw');
  assert.equal(ebay.suggested_price_factor, null, 'two sales is not evidence');
});

test('condition multipliers are checked against realised value', () => {
  // "Like new" items came back 20% under what that multiplier implied.
  const c = calibrate(many(8, { band: 'like_new', ratio: 0.8 }));
  const band = c.by_condition.find((b) => b.band === 'like_new');

  // Like-new is 1.0 now: the comps are already new-condition listings. If sales
  // say otherwise, this is where it shows up.
  assert.equal(band.current_multiplier, 1.0);
  assert.ok(Math.abs(band.suggested_multiplier - 0.8) < 0.001);
});

test('reports the share of predictions that landed close', () => {
  const rows = [...many(5, { predicted: 100, actual: 110 }), ...many(5, { predicted: 100, actual: 200, id: 50 })];
  const c = calibrate(rows);
  assert.ok(Math.abs(c.accuracy.within_25pct - 0.5) < 0.001);
});

test('no outcomes at all is reported, not crashed', () => {
  const c = calibrate([]);
  assert.equal(c.sales_recorded, 0);
  assert.equal(c.ready, false);
  assert.equal(c.accuracy.median_profit_error, null);
  assert.deepEqual(c.venue_mix, []);
});
