import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePending, retryDelay, sweepStale } from '../src/resolve.js';
import { matchProduct } from '../src/match.js';

const HOUR = 60 * 60 * 1000;

// Records every statement and hands back the pending listings and cached comps
// the test provides. Queue updates are read back out of the final batch.
function fakeDb({ pending = [], comps = [] } = {}) {
  const batches = [];
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({
      results: /score_due_at <= \?/.test(sql) ? pending : /FROM comps WHERE product_key IN/.test(sql) ? comps : [],
    }),
    run: async () => ({ meta: { changes: 0 } }),
  });
  return { batches, prepare: (sql) => stmt(sql), batch: async (s) => (batches.push(s), []) };
}

const queueUpdates = (db) =>
  new Map(
    db.batches
      .flat()
      .filter((s) => /^UPDATE listings SET score_due_at = \?, score_attempts = \? WHERE id = \?$/.test(s.sql))
      .map((s) => [s.args[2], { due: s.args[0], attempts: s.args[1] }])
  );

const listing = (id, title, attempts = 0) => ({
  id, title, price: 50, acquisition_mode: 'pickup', inbound_ship: 0, distance_mi: 5, category: '', score_attempts: attempts,
});

const liveComp = (product_key, median) => ({
  product_key, retail_price: median * 1.5, active_median: median, n_active: 12, source: 'ebay', expires_at: Date.now() + 24 * HOUR,
});

test('retries back off from 6 hours to a day to three days', () => {
  assert.equal(retryDelay(0), 6 * HOUR);
  assert.equal(retryDelay(1), 6 * HOUR);
  assert.equal(retryDelay(2), 24 * HOUR);
  assert.equal(retryDelay(3), 72 * HOUR);
  assert.equal(retryDelay(40), 72 * HOUR);
});

test('an empty queue ends the run without writing anything', async () => {
  const db = fakeDb();
  await resolvePending({ DB: db }, { fetchImpl: fetch });
  // Nothing pending → the run stops after the queue read; no batch at all.
  assert.equal(db.batches.length, 0);
});

test('a scored listing leaves the queue', async () => {
  const l = listing('a', 'Sony WH-1000XM4 headphones');
  const db = fakeDb({ pending: [l], comps: [liveComp(matchProduct('Sony WH-1000XM4 headphones').product_key, 400)] });
  const r = await resolvePending({ DB: db }, { fetchImpl: fetch });
  assert.equal(r.scored, 1);
  assert.deepEqual(queueUpdates(db).get('a'), { due: null, attempts: 0 });
});

test('comps in hand but no score counts as an attempt and backs off', async () => {
  // Priced, but at $50 against a $40 median there's no profit.
  const l = listing('b', 'Sony WH-1000XM4 headphones', 1);
  const db = fakeDb({ pending: [l], comps: [liveComp(matchProduct('Sony WH-1000XM4 headphones').product_key, 40)] });
  const before = Date.now();
  await resolvePending({ DB: db }, { fetchImpl: fetch });
  const u = queueUpdates(db).get('b');
  assert.equal(u.attempts, 2);
  assert.ok(u.due >= before + 24 * HOUR && u.due < before + 25 * HOUR);
});

test('a title that matches nothing backs off instead of retrying every run', async () => {
  const db = fakeDb({ pending: [listing('c', 'for sale obo', 2)] });
  await resolvePending({ DB: db }, { fetchImpl: fetch });
  assert.equal(queueUpdates(db).get('c').attempts, 3);
});

test('missing eBay credentials never count against a listing', async () => {
  // No comps and no credentials: the listing did nothing wrong, so it retries
  // at the first step and is ready the moment credentials land.
  const db = fakeDb({ pending: [listing('d', 'Garmin Fenix 7X watch', 0)] });
  const before = Date.now();
  await resolvePending({ DB: db }, { fetchImpl: fetch });
  const u = queueUpdates(db).get('d');
  assert.equal(u.attempts, 0);
  assert.ok(u.due < before + 7 * HOUR);
});

test('deferred listings keep their place in the queue', async () => {
  // Credentials present, budget exhausted up front: nothing can be priced, so
  // nothing should be rescheduled.
  const env = { EBAY_CLIENT_ID: 'x', EBAY_CLIENT_SECRET: 'y' };
  const pending = Array.from({ length: 5 }, (_, i) => listing(`e${i}`, `Garmin Fenix ${i}X watch`));
  const db = fakeDb({ pending });
  const meter = { used: 0, limit: 0, tick() { this.used += 1; }, canSpend: () => false };
  await resolvePending({ ...env, DB: db }, { fetchImpl: fetch, meter });
  assert.equal(queueUpdates(db).size, 0);
});

test('sweeping a listing as gone also removes it from the queue', async () => {
  const db = fakeDb();
  let sql = '';
  db.prepare = (s) => ((sql = s), { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) });
  await sweepStale(db);
  assert.match(sql, /score_due_at = NULL/);
});

test('a too-vague listing leaves the queue without an eBay lookup', async () => {
  // "Street co" matches on generic words only (0.30): even perfect comparables
  // couldn't lift it over the confidence gate, so pricing it spends a call for
  // nothing. The brand+model listing in the same run is still priced.
  const env = { EBAY_CLIENT_ID: 'x', EBAY_CLIENT_SECRET: 'y' };
  const db = fakeDb({ pending: [listing('v', 'Street co'), listing('s', 'Sony WH-1000XM4 headphones')] });
  const searched = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) };
    searched.push(new URL(u).searchParams.get('q'));
    return { ok: true, status: 200, json: async () => ({ itemSummaries: [] }) };
  };
  await resolvePending({ ...env, DB: db }, { fetchImpl });

  assert.deepEqual(searched, ['sony wh-1000xm4 headphone']);
  const dequeued = db.batches
    .flat()
    .filter((s) => /score_due_at = NULL/.test(s.sql))
    .map((s) => s.args[0]);
  assert.deepEqual(dequeued, ['v']);
});

test('eBay is searched with the title identity, and v2 confidence is stored in shadow', async () => {
  const env = { EBAY_CLIENT_ID: 'x', EBAY_CLIENT_SECRET: 'y' };
  const db = fakeDb({ pending: [listing('m', 'Selling my Sony WH-1000XM4 headphones, barely used, cash only')] });
  const searched = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) };
    searched.push(new URL(u).searchParams.get('q'));
    const items = [180, 190, 200, 210, 220, 230, 240, 250].map((p, i) => ({
      title: `Sony WH-1000XM4 Wireless Headphones ${i}`, price: { value: String(p) }, conditionId: '3000',
    }));
    return { ok: true, status: 200, json: async () => ({ itemSummaries: items }) };
  };
  await resolvePending({ ...env, DB: db }, { fetchImpl });

  // Sale chatter ("selling", "barely used", "cash only") stays out of the search.
  assert.deepEqual(searched, ['sony wh-1000xm4 headphone']);

  const score = db.batches.flat().find((s) => /INSERT INTO scores/.test(s.sql));
  const cols = score.sql.match(/INSERT INTO scores \(([^)]+)\)/)[1].split(',').map((c) => c.trim());
  const row = Object.fromEntries(cols.map((c, i) => [c, score.args[i]]));
  assert.ok(row.confidence_v2 > 0 && row.confidence_v2 < 1, String(row.confidence_v2));
  assert.equal(row.p_right, 0.9);
  assert.ok(row.expected_profit != null);

  const comp = db.batches.flat().find((s) => /INSERT INTO comps/.test(s.sql));
  const ccols = comp.sql.match(/INSERT INTO comps \(([^)]+)\)/)[1].split(',').map((c) => c.trim());
  const crow = Object.fromEntries(ccols.map((c, i) => [c, comp.args[i]]));
  assert.equal(crow.filtered, 1);
  assert.equal(crow.n_results, 8);
});
