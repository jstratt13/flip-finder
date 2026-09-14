import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { capturedListings, rankingReason, REASON_CODES } from '../src/captured.js';
import { SCORING } from '../src/config.js';

// Real SQL against the real migrations: the reason is now computed in the query
// so the dashboard can filter and tally everything captured, and it has to
// agree with rankingReason — which still writes the labels — on every branch.
const MIGRATIONS = new URL('../migrations/', import.meta.url);

function d1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => stmts.map((s) => ({ results: db.prepare(s.sql).all(...s.args) })),
  };
}

let seq = 0;
function seed(db, reason, { source = 'craigslist', title = `Item ${seq}` } = {}) {
  const id = `${source}:${++seq}`;
  const at = 1_000_000 + seq; // later seeds are "seen" more recently
  const run = (sql, ...a) => db.raw.prepare(sql).run(...a);

  run(
    `INSERT INTO listings (id, source, source_id, title, price, first_seen, last_seen, status)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, source, String(seq), title, reason === 'no_price' ? null : 100, at, at, reason === 'gone' ? 'gone' : 'active'
  );
  if (reason === 'acquired') {
    run(`INSERT INTO acquisitions (listing_id, acquired_at, price_paid, est_snapshot) VALUES (?,?,?,?)`, id, at, 90, '{}');
  }
  if (['acquired', 'gone', 'no_price', 'no_match'].includes(reason)) return id;

  const key = `key-${seq}`;
  run(`INSERT INTO listing_matches (listing_id, product_key, match_score, method, matched_at) VALUES (?,?,?,?,?)`, id, key, 0.9, 'test', at);
  if (reason === 'no_comps') return id;

  // Retail only, no used median: still counts as having comps.
  run(`INSERT INTO comps (product_key, retail_price, active_median, n_active, source, fetched_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
    key, 400, reason === 'no_margin' ? null : 200, 8, 'ebay', at, at + 1e9);

  const score = {
    no_margin: [null, null, 0.8, null],
    low_profit: [5, 10, 0.9, 0.5],
    low_confidence: [20, 60, 0.4, 0.5],
    low_roi: [20, 60, 0.9, 0.1],
    ranking: [40, 60, 0.9, 0.5],
  }[reason];
  const [s, profit, confidence, roi] = score;
  run(`INSERT INTO scores (listing_id, score, profit, confidence, roi, computed_at) VALUES (?,?,?,?,?,?)`, id, s, profit, confidence, roi, at);
  return id;
}

test('the SQL reason agrees with rankingReason on every branch', async () => {
  const db = d1();
  for (const code of REASON_CODES) seed(db, code);

  const { listings } = await capturedListings(db, { gates: SCORING });
  assert.equal(listings.length, REASON_CODES.length);

  // Every row: the reason the query filtered on is the reason the label says.
  for (const code of REASON_CODES) {
    const page = await capturedListings(db, { reason: code, gates: SCORING });
    assert.equal(page.count, 1, `${code}: expected exactly one row`);
    assert.equal(page.listings[0].reason.code, code);
    assert.equal(rankingReason(page.listings[0], SCORING).code, code);
  }
});

test('tallies count everything captured, not just the page', async () => {
  const db = d1();
  for (let i = 0; i < 5; i++) seed(db, 'no_comps');
  for (let i = 0; i < 3; i++) seed(db, 'ranking');

  const r = await capturedListings(db, { limit: 2, gates: SCORING });
  assert.equal(r.count, 2);
  assert.equal(r.total, 8);
  assert.deepEqual(r.summary, { no_comps: 5, ranking: 3 });
});

test('filtering by reason returns only that reason, newest first', async () => {
  const db = d1();
  const older = seed(db, 'no_match');
  seed(db, 'ranking');
  const newer = seed(db, 'no_match');

  const r = await capturedListings(db, { reason: 'no_match', gates: SCORING });
  assert.deepEqual(r.listings.map((l) => l.id), [newer, older]);
  assert.equal(r.matching, 2);
  assert.equal(r.reason, 'no_match');
});

test('a filtered page keeps every reason in the tallies to switch to', async () => {
  const db = d1();
  seed(db, 'no_match');
  seed(db, 'ranking');
  const r = await capturedListings(db, { reason: 'ranking', gates: SCORING });
  assert.deepEqual(r.summary, { no_match: 1, ranking: 1 });
});

test('the filter combines with source and search', async () => {
  const db = d1();
  seed(db, 'no_comps', { source: 'facebook', title: 'Aeron chair' });
  seed(db, 'no_comps', { source: 'craigslist', title: 'Aeron chair' });
  seed(db, 'no_comps', { source: 'facebook', title: 'Leap chair' });

  const r = await capturedListings(db, { source: 'facebook', q: 'aeron', reason: 'no_comps', gates: SCORING });
  assert.equal(r.count, 1);
  assert.equal(r.listings[0].source, 'facebook');
  assert.equal(r.total, 1);
});

test('an unknown reason is ignored rather than returning nothing', async () => {
  const db = d1();
  seed(db, 'ranking');
  const r = await capturedListings(db, { reason: "x' OR 1=1 --", gates: SCORING });
  assert.equal(r.count, 1);
  assert.equal(r.reason, null);
});

test('the gates bound into the SQL are the ones passed in', async () => {
  // A listing at $60 profit is low_profit if the floor is raised to $100.
  const db = d1();
  seed(db, 'ranking');
  const r = await capturedListings(db, { reason: 'low_profit', gates: { ...SCORING, min_profit: 100 } });
  assert.equal(r.count, 1);
  assert.equal(r.listings[0].reason.code, 'low_profit');
});
