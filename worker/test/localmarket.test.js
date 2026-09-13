import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localMarketRatio, RATIO_BOUNDS } from '../src/calibrate.js';

// One product's worth of pairs: a national comp plus local sightings priced at
// `ratio` times that comp.
function product(key, ebayMedian, ratio, n = 4) {
  return Array.from({ length: n }, () => ({
    product_key: key,
    ebay_median: ebayMedian,
    price: ebayMedian * ratio,
  }));
}

const many = (count, ratio, n = 4) =>
  Array.from({ length: count }, (_, i) => product(`p${i}`, 200, ratio, n)).flat();

// Matches VENUES.facebook.price_factor, which the suggestion scales.
const CURRENT_FACTOR = 0.85;

test('says nothing until enough products have been compared', () => {
  const r = localMarketRatio(many(4, 0.8));
  assert.equal(r.ready, false);
  assert.equal(r.products_compared, 4);
  assert.equal(r.suggested_price_factor, null, 'must not suggest on a thin sample');
  assert.equal(r.min_products_needed, 10);
});

test('a product with too few local sightings does not contribute', () => {
  // Two sightings is not a local price, it is a coincidence.
  const r = localMarketRatio(many(12, 0.8, 2));
  assert.equal(r.products_compared, 0);
  assert.equal(r.ready, false);
});

test('measures the local discount across products', () => {
  // Local asks consistently 80% of national.
  const r = localMarketRatio(many(12, 0.8));
  assert.equal(r.ready, true);
  assert.equal(r.products_compared, 12);
  assert.ok(Math.abs(r.median_ratio - 0.8) < 0.001);
  // 0.85 current × 0.8 observed = 0.68
  assert.ok(Math.abs(r.suggested_price_factor - 0.68) < 0.001);
});

test('an expensive local market is captured, not suppressed', () => {
  // Southern California genuinely commanding more is a real effect worth
  // keeping — it means more is realised locally, not less.
  const r = localMarketRatio(many(12, 1.2));
  assert.ok(r.median_ratio > 1, 'the measurement must reflect it');
  assert.ok(r.suggested_price_factor > CURRENT_FACTOR, 'and raise the factor');
});

test('an implausible ratio is clamped, and the clamp is visible', () => {
  // A thin or skewed sample can throw a number no real market produces.
  const r = localMarketRatio(many(12, 3.0));
  assert.equal(r.was_clamped, true);
  assert.equal(r.suggested_price_factor, RATIO_BOUNDS.max);
  assert.ok(r.raw_suggestion > RATIO_BOUNDS.max, 'the unclamped value is still reported');
});

test('a plausible ratio is left alone', () => {
  const r = localMarketRatio(many(12, 0.95));
  assert.equal(r.was_clamped, false);
  assert.equal(r.suggested_price_factor, r.raw_suggestion);
});

test('spread is reported so a noisy median can be spotted', () => {
  // Half the products cheap locally, half expensive: the median looks fine but
  // the quartiles show it is describing nothing consistent.
  const rows = [...many(6, 0.6), ...Array.from({ length: 6 }, (_, i) =>
    product(`q${i}`, 200, 1.1)).flat()];
  const r = localMarketRatio(rows);

  assert.ok(r.p75_ratio - r.p25_ratio > 0.3, 'wide spread must be visible');
});

test('outlier listings within a product do not move its ratio', () => {
  // One absurd local ask among sensible ones; the per-product median holds.
  const rows = [
    ...product('a', 200, 1.0, 6),
    { product_key: 'a', ebay_median: 200, price: 99999 },
    ...many(11, 1.0),
  ];
  const r = localMarketRatio(rows);
  assert.ok(Math.abs(r.median_ratio - 1.0) < 0.05);
});

test('no data at all is reported, not crashed', () => {
  const r = localMarketRatio([]);
  assert.equal(r.products_compared, 0);
  assert.equal(r.ready, false);
  assert.equal(r.median_ratio, null);
  assert.equal(r.suggested_price_factor, null);
});
