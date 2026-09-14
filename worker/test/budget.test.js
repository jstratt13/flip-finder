import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePending } from '../src/resolve.js';
import { createMeter, metered, SUBREQUEST_LIMIT } from '../src/budget.js';

// A fake Cloudflare that enforces the free plan independently of our meter:
// every D1 call, KV call and fetch counts, and the 51st throws — as production
// would. If the budget logic undercounts anything, these tests blow up here.
function freePlan({ pending = [], scoresOut = [], ebayFetchedToday = 0 } = {}) {
  let used = 0;
  const spend = () => {
    used += 1;
    if (used > SUBREQUEST_LIMIT) throw new Error('Too many subrequests.');
  };

  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    all: async () => {
      spend();
      if (/score_due_at <= \?/.test(sql)) return { results: pending };
      if (/FROM comps WHERE source = 'ebay'/.test(sql)) return { results: [{ n: ebayFetchedToday }] };
      return { results: [] };
    },
    first: async () => (spend(), null),
    run: async () => (spend(), { meta: { changes: 0 } }),
  });

  const kv = new Map();
  const env = {
    EBAY_CLIENT_ID: 'id',
    EBAY_CLIENT_SECRET: 'secret',
    DB: {
      prepare: (sql) => stmt(sql),
      batch: async (stmts) => {
        spend();
        for (const s of stmts) if (/INSERT INTO scores/.test(s.sql)) scoresOut.push(s.args[0]);
        return [];
      },
    },
    CACHE: {
      get: async (k) => (spend(), kv.get(k) ?? null),
      put: async (k, v) => (spend(), kv.set(k, JSON.parse(v))),
    },
  };

  const fetchImpl = async (url) => {
    spend();
    const body = String(url).includes('oauth')
      ? { access_token: 't', expires_in: 7200 }
      : {
          itemSummaries: [100, 120, 140, 160, 180].map((v, i) => ({
            itemId: String(i), title: 'x', price: { value: v }, conditionId: i < 2 ? '1000' : '3000',
          })),
        };
    return { ok: true, status: 200, json: async () => body };
  };

  return { env, fetchImpl, used: () => used };
}

const listings = (n, title = (i) => `Sony WH-${1000 + i}XM4 headphones`) =>
  Array.from({ length: n }, (_, i) => ({
    id: `craigslist:${i}`,
    title: title(i),
    price: 50,
    acquisition_mode: 'pickup',
    inbound_ship: 0,
    distance_mi: 5,
    category: 'electronics',
  }));

test('a run with a large eBay backlog stays inside the free-plan limit', async () => {
  const scoresOut = [];
  const plat = freePlan({ pending: listings(100), scoresOut });

  const r = await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });

  assert.ok(plat.used() <= SUBREQUEST_LIMIT, `${plat.used()} subrequests`);
  // 16 once the token is read once per run and comps ride in the score batch;
  // 6 before. A regression here halves how fast the backlog drains.
  assert.ok(r.comp_fetches >= 16, `only ${r.comp_fetches} products priced in a run`);
  assert.ok(r.deferred > 0, 'the rest waits for the next run');
  // The meter's own count agrees with the platform's.
  assert.equal(r.subrequests, plat.used());
});

test('the eBay token is read once per run, not once per search', async () => {
  const plat = freePlan({ pending: listings(100) });
  let tokenReads = 0;
  const get = plat.env.CACHE.get;
  plat.env.CACHE.get = async (k) => ((tokenReads += k === 'ebay:token' ? 1 : 0), get(k));
  const r = await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });
  assert.ok(r.comp_fetches > 1);
  assert.equal(tokenReads, 1);
});

test('comp writes are saved in the same batch as the scores', async () => {
  const plat = freePlan({ pending: listings(100) });
  const batches = [];
  const batch = plat.env.DB.batch;
  plat.env.DB.batch = async (stmts) => (batches.push(stmts.map((s) => s.sql)), batch(stmts));
  await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });
  const last = batches.at(-1);
  assert.ok(last.some((sql) => /INSERT INTO comps/.test(sql)), 'comps missing from the final batch');
  assert.ok(last.some((sql) => /INSERT INTO scores/.test(sql)));
});

test('deferred products get no score row, so the next run picks them up', async () => {
  const scoresOut = [];
  const plat = freePlan({ pending: listings(100), scoresOut });
  const r = await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });

  // One listing per product here, so scored rows = products actually priced.
  assert.equal(scoresOut.length, r.products - r.deferred);
  assert.ok(scoresOut.length < 100);
});

test('a bulky backlog is budgeted too', async () => {
  // Every title a distinct local pool: each costs a D1 query of its own.
  const materials = ['oak', 'pine', 'walnut', 'teak', 'maple', 'glass', 'metal', 'leather', 'fabric', 'velvet'];
  const types = ['dresser', 'desk', 'bookcase', 'nightstand', 'sofa', 'recliner', 'armoire', 'credenza', 'hutch', 'vanity'];
  const plat = freePlan({
    pending: listings(100, (i) => `${materials[i % 10]} ${types[Math.floor(i / 10)]}`),
  });
  const r = await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });
  assert.ok(plat.used() <= SUBREQUEST_LIMIT, `${plat.used()} subrequests`);
  assert.ok(r.deferred > 0);
});

// Runs the cron repeatedly, removing whatever got a score row each time, the
// way the pending query would. A budget that defers without making progress
// shows up here as a backlog that never drains.
async function drain(backlog) {
  let remaining = backlog;
  for (let run = 1; run <= 60; run++) {
    const scoresOut = [];
    const plat = freePlan({ pending: remaining.slice(0, 100), scoresOut });
    await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });
    assert.ok(plat.used() <= SUBREQUEST_LIMIT, `run ${run}: ${plat.used()} subrequests`);
    assert.ok(scoresOut.length > 0, `run ${run} made no progress with ${remaining.length} waiting`);
    const done = new Set(scoresOut);
    remaining = remaining.filter((l) => !done.has(l.id));
    if (!remaining.length) return run;
  }
  assert.fail(`backlog not drained after 60 runs: ${remaining.length} left`);
}

const BULKY = (i) => {
  const materials = ['oak', 'pine', 'walnut', 'teak', 'maple', 'glass', 'metal', 'leather', 'fabric', 'velvet'];
  const types = ['dresser', 'desk', 'bookcase', 'nightstand', 'sofa', 'recliner', 'armoire', 'credenza', 'hutch', 'vanity'];
  return `${materials[i % 10]} ${types[Math.floor(i / 10) % 10]}`;
};

test('an eBay backlog drains, every run making progress', async () => {
  const runs = await drain(listings(60));
  assert.ok(runs > 1 && runs <= 20, `${runs} runs`);
});

test('a backlog of cold local pools drains too', async () => {
  // Cold pools need a local query AND an eBay fallback. Budgeting the two
  // separately deferred every fallback forever.
  const runs = await drain(listings(60, BULKY));
  assert.ok(runs <= 20, `${runs} runs`);
});

test('a run prices at most 30 eBay products', async () => {
  // Parsing each eBay page costs CPU against the free plan's 10 ms; the
  // subrequest budget alone would allow a few more.
  const plat = freePlan({ pending: listings(50) });
  const r = await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });
  assert.equal(r.comp_fetches, 30);
  assert.ok(plat.used() <= SUBREQUEST_LIMIT);
});

test('products past the per-run cap wait for the next run, not six hours', async () => {
  const plat = freePlan({ pending: listings(50) });
  const rescheduled = new Set();
  const batch = plat.env.DB.batch;
  plat.env.DB.batch = async (stmts) => {
    for (const s of stmts) if (/UPDATE listings SET score_due_at/.test(s.sql)) rescheduled.add(s.args[2]);
    return batch(stmts);
  };
  const r = await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });
  assert.equal(r.comp_fetches, 30);
  assert.equal(r.deferred, 20);
  // Exactly the 30 priced listings moved in the queue; the other 20 stay due.
  assert.equal(rescheduled.size, 30);
});

test('lookups stop at the daily eBay allowance', async () => {
  // 4,495 products fetched in the last 24 hours, one call each, of 4,500.
  const plat = freePlan({ pending: listings(50), ebayFetchedToday: 4495 });
  const r = await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });
  assert.equal(r.comp_fetches, 5);
});

test('with the eBay allowance used up, listings wait rather than back off', async () => {
  const plat = freePlan({ pending: listings(50), ebayFetchedToday: 4500 });
  const r = await resolvePending(plat.env, { fetchImpl: plat.fetchImpl });
  assert.equal(r.comp_fetches, 0);
  // No comps were in hand, so no listing's attempt count may advance.
  const batches = [];
  const plat2 = freePlan({ pending: listings(50), ebayFetchedToday: 4500 });
  const batch = plat2.env.DB.batch;
  plat2.env.DB.batch = async (stmts) => (batches.push(...stmts), batch(stmts));
  await resolvePending(plat2.env, { fetchImpl: plat2.fetchImpl });
  const attempts = batches
    .filter((s) => /UPDATE listings SET score_due_at/.test(s.sql))
    .map((s) => s.args[1]);
  assert.ok(attempts.length > 0);
  assert.ok(attempts.every((a) => a === 0), `attempts advanced: ${attempts}`);
});

test('without eBay credentials no lookups are attempted at all', async () => {
  const plat = freePlan({ pending: listings(100) });
  delete plat.env.EBAY_CLIENT_ID;
  delete plat.env.EBAY_CLIENT_SECRET;

  let external = 0;
  const countingFetch = async (...a) => (external++, plat.fetchImpl(...a));
  const r = await resolvePending(plat.env, { fetchImpl: countingFetch });

  assert.equal(external, 0);
  assert.equal(r.deferred, 0, 'nothing is waiting on budget, only on credentials');
  assert.ok(plat.used() < 15, `${plat.used()} subrequests for a run that prices nothing`);
});

test('the metered D1 passes raw statements to batch', async () => {
  let received;
  const raw = { bind: () => raw };
  const db = { prepare: () => raw, batch: async (s) => ((received = s), []) };
  const meter = createMeter();
  const { env } = metered({ DB: db }, fetch, meter);
  await env.DB.batch([env.DB.prepare('x').bind(1)]);
  assert.equal(received[0], raw);
  assert.equal(meter.used, 1);
});
