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

// Ingest refuses a listing whose condition nobody stated, so the shared fixture
// states one. bare() is the same card with nothing said about condition — what
// a Craigslist search page actually gives us.
const bare = (overrides = {}) => ({
  source: 'craigslist', source_id: '100', title: 'Sony WH-1000XM4 headphones', price: 150,
  location_name: 'Irvine', capture_phase: 'grid', ...overrides,
});

const grid = (overrides = {}) => bare({ condition_raw: 'good', ...overrides });

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

  // A bare grid card would be refused outright as a new listing; on one already
  // stored it must still land, and must not erase what the detail page said.
  tick(2 * HOUR);
  await ingest(db, [bare()]);
  assert.equal(condition(db).band, 'like_new');
  assert.ok(condition(db).confidence > 0.5);
});

test('a detail page still upgrades a grid-only condition', async (t) => {
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [grid()]);
  assert.equal(condition(db).band, 'good');

  tick(60 * 1000);
  await ingest(db, [detail()]);
  assert.equal(condition(db).band, 'like_new');
  assert.ok(row(db).description.startsWith('Barely used'));
});

test('grid and detail for one listing in the same batch keep the detail condition', async (t) => {
  withClock(t, T0);
  const db = d1();
  await ingest(db, [detail(), bare()]);
  assert.equal(condition(db).band, 'like_new');
});

// ------------------------------------------------ condition stated, or refused

test('a listing whose condition nobody stated never enters the system', async (t) => {
  withClock(t, T0);
  const db = d1();

  // A Craigslist search card: title and price, nothing about condition.
  const r = await ingestBatch(db, [bare({ source_id: 'silent' })]);
  assert.equal(r.accepted, 0);
  assert.equal(r.rejected[0].error, 'no description');
  assert.equal(row(db, 'craigslist:silent'), undefined);
});

test('a description that says nothing about condition is refused too', async (t) => {
  withClock(t, T0);
  const db = d1();
  const r = await ingestBatch(db, [
    bare({ source_id: 'quiet', description: 'Pickup in Irvine only. Cash. Text me for the address, no lowballs.' }),
  ]);
  assert.equal(r.accepted, 0);
  assert.equal(r.rejected[0].error, 'description states no condition');
  assert.equal(row(db, 'craigslist:quiet'), undefined);
});

test('a stated condition is enough, wherever it is stated', async (t) => {
  withClock(t, T0);
  const db = d1();

  // In the description...
  const a = await ingestBatch(db, [bare({ source_id: 'prose', description: 'Barely used, no scratches.' })]);
  assert.equal(a.accepted, 1);

  // ...in Facebook's own condition field, with no description at all...
  const b = await ingestBatch(db, [bare({ source_id: 'field', source: 'facebook', condition_raw: 'Used - Like New' })]);
  assert.equal(b.accepted, 1);

  // ...or in the title, which is where most of ours come from.
  const c = await ingestBatch(db, [bare({ source_id: 'title', title: 'Sony WH-1000XM4 headphones - mint condition' })]);
  assert.equal(c.accepted, 1);
});

test('a listing already stored is not refused by a later bare grid card', async (t) => {
  // It was accepted under the rules of its day, and the card carries a price
  // drop that has to reach it.
  const tick = withClock(t, T0);
  const db = d1();
  await ingest(db, [detail()]);

  tick(2 * HOUR);
  const r = await ingestBatch(db, [bare({ price: 120 })]);
  assert.equal(r.accepted, 1);
  assert.equal(row(db).price, 120);
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
  assert.equal(await ingest(db, [bare({ location_name: exact.location_name })]), 0);
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

test('whole vehicles are refused at ingest; their parts are not', async (t) => {
  withClock(t, T0);
  const db = d1();
  const r = await ingestBatch(db, [
    grid({ source_id: 'truck', title: '1992 Dodge Ram 50 · Short Bed', price: 750 }),
    grid({ source_id: 'battery', title: 'Interstate Group 24F Car Battery', price: 50 }),
  ]);
  assert.deepEqual(stored(db), ['craigslist:battery']);
  assert.match(r.rejected[0].error, /^vehicle/);
});

test('a listing sold for parts never enters the system', async (t) => {
  withClock(t, T0);
  const db = d1();

  for (const [id, text] of [
    ['broken', 'Works intermittently, sold as-is for parts.'],
    ['repair', 'Screen needs repair, everything else fine.'],
    ['dead', 'Not working, no power.'],
  ]) {
    const r = await ingestBatch(db, [bare({ source_id: id, description: text })]);
    assert.equal(r.accepted, 0, text);
    assert.equal(r.rejected[0].error, 'sold for parts');
  }

  // Damaged but working is a different thing, and still priced — at a discount.
  const fair = await ingestBatch(db, [bare({ source_id: 'cracked', description: 'Cracked corner, works fine.' })]);
  assert.equal(fair.accepted, 1);
});
