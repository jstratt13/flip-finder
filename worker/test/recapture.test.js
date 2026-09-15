import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ingestBatch } from '../src/ingest.js';

// Real SQL, not a fake: the upsert WHERE clauses are the whole change, and only
// SQLite can say whether they skip what they should. The schema comes from the
// same migrations D1 runs.
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
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes) } };
    },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    // D1 runs a batch's statements in order; these synchronous calls do too.
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())).then(() => []),
  };
}

function withClock(t, start) {
  t.mock.timers.enable({ apis: ['Date'], now: start });
  return (ms) => t.mock.timers.tick(ms);
}

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 13, 20, 0, 0);

const grid = (overrides = {}) => ({
  source: 'craigslist', source_id: '100', title: 'Sony WH-1000XM4 headphones', price: 150,
  location_name: 'Irvine', capture_phase: 'grid', ...overrides,
});

const detail = (overrides = {}) => grid({
  capture_phase: 'detail', condition_raw: 'like new',
  description: 'Barely used, like new condition, no scratches, includes case and cable, works perfectly.',
  ...overrides,
});

const row = (db, id = 'craigslist:100') => db.raw.prepare('SELECT * FROM listings WHERE id = ?').get(id);
const condition = (db, id = 'craigslist:100') =>
  db.raw.prepare('SELECT band, confidence FROM conditions WHERE listing_id = ?').get(id);

async function ingest(db, items) {
  // Rows changed by this ingest — what D1 bills as rows written, before
  // counting the index entries each change also touches.
  const count = () => Number(db.raw.prepare('SELECT total_changes() AS n').get().n);
  const before = count();
  await ingestBatch(db, items);
  return count() - before;
}

test('an unchanged re-capture within the hour writes nothing', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  assert.ok((await ingest(db, [grid()])) > 0, 'first capture writes');

  tick(10 * 60 * 1000);
  assert.equal(await ingest(db, [grid()]), 0);
});

test('an unchanged re-capture after an hour refreshes last_seen', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [grid()]);

  tick(HOUR + 1000);
  assert.ok((await ingest(db, [grid()])) > 0);
  assert.equal(row(db).last_seen, T0 + HOUR + 1000);
});

test('a price change is written immediately, with its history', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [grid()]);

  tick(60 * 1000);
  await ingest(db, [grid({ price: 120 })]);
  assert.equal(row(db).price, 120);
  const history = db.raw.prepare('SELECT price FROM price_history ORDER BY observed_at').all().map((r) => r.price);
  assert.deepEqual(history, [150, 120]);
});

test('a grid card no longer erases a detail page condition', async (t) => {
  // Reproduced on local D1 before the fix: like_new (0.9) became unknown (0.2).
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [detail()]);
  assert.equal(condition(db).band, 'like_new');

  tick(2 * HOUR);
  await ingest(db, [grid()]);
  assert.equal(condition(db).band, 'like_new');
  assert.ok(condition(db).confidence > 0.5);
});

test('a detail page still upgrades a grid-only condition', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [grid()]);
  assert.equal(condition(db).band, 'unknown');

  tick(60 * 1000);
  await ingest(db, [detail()]);
  assert.equal(condition(db).band, 'like_new');
  assert.ok(row(db).description.startsWith('Barely used'));
});

test('grid and detail for one listing in the same batch keep the detail condition', async (t) => {
  withClock(t, T0);
  const db = d1();
  await ingest(db, [detail(), grid()]);
  assert.equal(condition(db).band, 'like_new');
});

test('condition text from the old Craigslist adapter is trimmed to its own line', async (t) => {
  // Exactly what production stored before the adapter fix.
  withClock(t, T0);
  const db = d1();
  await ingest(db, [detail({ condition_raw: 'good\nmake', description: null })]);
  assert.equal(row(db).condition_raw, 'good');
  assert.equal(condition(db).band, 'good');
});

test('a listing swept as gone and seen again rejoins the scoring queue', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [grid()]);
  db.raw.exec("UPDATE listings SET status = 'gone', score_due_at = NULL");

  tick(60 * 1000);
  await ingest(db, [grid()]);
  assert.equal(row(db).status, 'active');
  assert.equal(row(db).score_due_at, T0 + 60 * 1000);
});

test('city coordinates never overwrite exact ones, and trying costs no write', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [detail({ lat: 33.7, lon: -117.8 })]);
  const exact = row(db);
  assert.equal(exact.geo_source, 'exact');

  tick(5 * 60 * 1000);
  // A grid card naming a city resolves to its centroid.
  assert.equal(await ingest(db, [grid({ location_name: exact.location_name })]), 0);
  assert.equal(row(db).lat, exact.lat);
});

// ------------------------------------------------ capture price range ($5–$1,000)

const stored = (db) => db.raw.prepare('SELECT id FROM listings ORDER BY id').all().map((r) => r.id);

test('listings with no price, under $5 or over $1,000 are refused', async (t) => {
  withClock(t, T0);
  const db = d1();
  const r = await ingestBatch(db, [
    grid({ source_id: 'noprice', price: null }),
    grid({ source_id: 'one', price: 1 }),
    grid({ source_id: 'fourish', price: 4.99 }),
    grid({ source_id: 'five', price: 5 }),
    grid({ source_id: 'thousand', price: 1000 }),
    grid({ source_id: 'car', price: 27500 }),
  ]);
  assert.deepEqual(stored(db), ['craigslist:five', 'craigslist:thousand']);
  assert.equal(r.accepted, 2);
  assert.deepEqual(
    r.rejected.map((x) => x.error).sort(),
    ['no price', 'price over $1000', 'price under $5', 'price under $5'].sort()
  );
  // Nothing refused joins the scoring queue or writes price history.
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM price_history').get().n, 2);
});

test('a detail page without a price still upgrades a listing stored with one', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [grid()]);
  tick(60 * 1000);
  const r = await ingestBatch(db, [detail({ price: null })]);
  assert.equal(r.accepted, 1);
  assert.equal(condition(db).band, 'like_new');
  assert.equal(row(db).price, 150);
});

test('a price carried by the grid card in the same batch covers its detail page', async (t) => {
  withClock(t, T0);
  const db = d1();
  const r = await ingestBatch(db, [grid(), detail({ price: null })]);
  assert.equal(r.accepted, 2);
  assert.equal(condition(db).band, 'like_new');
});

test('a stored listing re-captured above $1,000 keeps its last in-range record', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [grid({ price: 900 })]);
  tick(2 * HOUR);
  const r = await ingestBatch(db, [grid({ price: 1200 })]);
  assert.equal(r.accepted, 0);
  assert.equal(row(db).price, 900);
});
