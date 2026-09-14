import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePending } from '../src/resolve.js';
import { ingestBatch } from '../src/ingest.js';
import { chunk, allIn } from '../src/d1.js';

// Behaves like D1 on the one point that matters here: any statement binding
// more than 100 parameters throws, exactly as production did at 17:15 on
// 2026-09-13 ("too many SQL variables"). Everything else returns empty rows,
// except the pending-listing query, which returns the backlog we hand it.
function strictD1({ pending = [] } = {}) {
  const check = (sql, args) => {
    if (args.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${args.length}): ${sql.slice(0, 60)}`);
  };
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    all: async () => {
      check(sql, args);
      return { results: /LEFT JOIN scores s/.test(sql) ? pending : [] };
    },
    first: async () => (check(sql, args), null),
    run: async () => (check(sql, args), { meta: { changes: 0, last_row_id: 1 } }),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      for (const s of stmts) check(s.sql, s.args);
      return [];
    },
  };
}

test('chunk splits under the limit and keeps every value', () => {
  const parts = chunk(Array.from({ length: 200 }, (_, i) => i));
  assert.ok(parts.every((p) => p.length <= 90));
  assert.equal(parts.flat().length, 200);
});

test('allIn binds trailing parameters on every chunk', async () => {
  const seen = [];
  const db = {
    prepare: (sql) => ({ bind: (...a) => ({ all: async () => (seen.push(a), { results: [{ n: a.length }] }) }) }),
  };
  const rows = await allIn(db, (ph) => `x IN (${ph}) AND t > ?`, Array.from({ length: 95 }), [42]);
  assert.equal(rows.length, 2);
  assert.ok(seen.every((a) => a.at(-1) === 42));
});

test('the cron survives a backlog of more than 100 distinct products', async () => {
  // 200 listings, each its own product: the shape that broke production.
  const pending = Array.from({ length: 200 }, (_, i) => ({
    id: `craigslist:${i}`,
    title: `Sony WH-${1000 + i}XM4 headphones`,
    price: 100,
    acquisition_mode: 'pickup',
    inbound_ship: 0,
    distance_mi: 5,
    category: 'electronics',
  }));
  const failingFetch = async () => {
    throw new Error('no network in tests');
  };

  const r = await resolvePending({ DB: strictD1({ pending }) }, { limit: 200, fetchImpl: failingFetch });
  assert.equal(r.pending, 200);
  assert.ok(r.products > 100, `only ${r.products} products — the test would not reach the limit`);
});

test('ingest accepts a batch larger than 100', async () => {
  // The server allows up to 500 per request; only the extension's own cap
  // used to keep ingest under the limit.
  const items = Array.from({ length: 150 }, (_, i) => ({
    source: 'craigslist',
    source_id: String(9000 + i),
    title: `DeWalt DCD${700 + i} drill`,
    price: 80,
    capture_phase: 'grid',
  }));
  const r = await ingestBatch(strictD1(), items);
  assert.equal(r.accepted, 150);
});
