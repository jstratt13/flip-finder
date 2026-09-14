import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchProduct } from '../src/match.js';
import { fetchComps, _internal } from '../src/ebay.js';

test('generation digits are never folded away', () => {
  // Collapsing ps4/ps5 into "playstation" would hand a PS4 the PS5's comps.
  const ps5 = matchProduct('PS5 Slim Disc Edition - like new');
  const ps4 = matchProduct('PS4 Slim 1TB console');
  assert.notEqual(ps5.product_key, ps4.product_key);
});

test('word-order variants collapse to one key', () => {
  const a = matchProduct('Sony WH-1000XM4 headphones - $150 obo');
  const b = matchProduct('WH-1000XM4 Sony headphones');
  assert.equal(a.product_key, b.product_key);
  // ...but the query keeps natural order so it reads like a real search.
  assert.equal(a.query, 'sony wh-1000xm4 headphones');
});

test('model years are not treated as model numbers', () => {
  const a = matchProduct('Apple late-2013 21.5" iMac screen');
  const b = matchProduct('Apple late-2015 21.5" iMac screen');
  assert.notEqual(a.product_key, b.product_key);
  assert.ok(a.match_score < 0.9, 'a year should not earn brand+model confidence');
});

test('condition and sales chatter is stripped from the key', () => {
  const a = matchProduct('DeWalt DCD777 drill');
  const b = matchProduct('Selling my DeWalt DCD777 drill, barely used, cash only, must go!');
  assert.equal(a.product_key, b.product_key);
});

test('vague titles score too low to reach the ranking', () => {
  assert.ok(matchProduct('Free pile of cables').match_score <= 0.3);
  assert.equal(matchProduct('   '), null);
});

test('comp summary trims outliers before taking the median', () => {
  // One $5 accessory and one $9,999 joke listing must not move the median.
  const prices = [5, 180, 190, 195, 200, 205, 210, 215, 220, 9999];
  const s = _internal.summarize(prices);
  assert.ok(s.median > 190 && s.median < 215, `median was ${s.median}`);
  assert.equal(s.n, 10);
});

test('empty comp set yields nulls rather than zeros', () => {
  const s = _internal.summarize([]);
  assert.equal(s.median, null);
  assert.equal(s.n, 0);
});

function fakeEnv() {
  const store = new Map();
  return {
    EBAY_CLIENT_ID: 'id',
    EBAY_CLIENT_SECRET: 'secret',
    CACHE: {
      get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      put: async (k, v) => store.set(k, v),
    },
  };
}

function fakeFetch(newPrices, usedPrices, { conditionText = false } = {}) {
  const calls = [];
  return {
    calls,
    impl: async (url, opts) => {
      calls.push(String(url));
      if (String(url).includes('oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) };
      }
      // One mixed page, as eBay returns it: each summary carries its condition.
      const item = (p, i, id, text) => ({
        itemId: `v1|${id}${i}|0`,
        title: 'thing',
        price: { value: String(p) },
        ...(conditionText ? { condition: text } : { conditionId: id, condition: text }),
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          itemSummaries: [
            ...usedPrices.map((p, i) => item(p, i, '3000', 'Used')),
            ...newPrices.map((p, i) => item(p, i, '1000', 'New')),
          ],
        }),
      };
    },
  };
}

test('fetchComps separates the retail anchor from the used signal', async () => {
  const env = fakeEnv();
  const f = fakeFetch([400, 410, 420, 430, 440], [190, 200, 210, 205, 195]);

  const comp = await fetchComps(env, { product_key: 'sony-wh-1000xm4', query: 'sony wh-1000xm4' }, f.impl);

  assert.ok(comp.retail_price > 400 && comp.retail_price < 440);
  assert.ok(comp.active_median > 190 && comp.active_median < 215);
  assert.equal(comp.n_active, 5);
  assert.equal(comp.source, 'ebay');
  assert.ok(comp.expires_at > comp.fetched_at);
});

test('the oauth token is cached across calls', async () => {
  const env = fakeEnv();
  const f = fakeFetch([100], [50]);

  await fetchComps(env, { product_key: 'a', query: 'a' }, f.impl);
  await fetchComps(env, { product_key: 'b', query: 'b' }, f.impl);

  const tokenCalls = f.calls.filter((u) => u.includes('oauth2/token')).length;
  assert.equal(tokenCalls, 1, 'should reuse the cached token');
});

test('an outage throws rather than caching an empty result', async () => {
  // Caching "no comps" after a failed lookup would suppress retries for days.
  const env = fakeEnv();
  const impl = async (url) => {
    if (String(url).includes('oauth2/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) };
    }
    return { ok: false, status: 500 };
  };

  await assert.rejects(() => fetchComps(env, { product_key: 'x', query: 'x' }, impl));
});

test('a genuine empty result is cached, but expires sooner', async () => {
  const env = fakeEnv();
  const f = fakeFetch([], []);

  const comp = await fetchComps(env, { product_key: 'x', query: 'x' }, f.impl);
  assert.equal(comp.active_median, null);
  assert.equal(comp.n_active, 0);

  const DAY = 24 * 60 * 60 * 1000;
  const ttl = comp.expires_at - comp.fetched_at;
  assert.equal(ttl, 3 * DAY, 'empty comps should use the short TTL');
});

test('priced comps are kept for two weeks', async () => {
  const env = fakeEnv();
  const f = fakeFetch([400], [200]);
  const comp = await fetchComps(env, { product_key: 'x', query: 'x' }, f.impl);
  assert.equal(comp.expires_at - comp.fetched_at, 14 * 24 * 60 * 60 * 1000);
});

test('one search per product asks for both conditions', async () => {
  const env = fakeEnv();
  const f = fakeFetch([400], [200]);
  await fetchComps(env, { product_key: 'x', query: 'x' }, f.impl);

  const searches = f.calls.filter((u) => u.includes('item_summary/search'));
  assert.equal(searches.length, 1);
  assert.ok(decodeURIComponent(searches[0]).includes('conditionIds:{1000|3000}'));
});

test('a page of only used listings gives the used signal and no retail anchor', async () => {
  const env = fakeEnv();
  const f = fakeFetch([], [190, 200, 210]);
  const comp = await fetchComps(env, { product_key: 'x', query: 'x' }, f.impl);
  assert.equal(comp.retail_price, null);
  assert.equal(comp.active_median, 200);
});

test('condition text is used when a summary has no condition id', async () => {
  const env = fakeEnv();
  const f = fakeFetch([400, 420], [200, 210], { conditionText: true });
  const comp = await fetchComps(env, { product_key: 'x', query: 'x' }, f.impl);
  assert.ok(comp.retail_price >= 400);
  assert.equal(comp.n_active, 2);
});

test('conditions that were not asked for never leak into either side', async () => {
  const env = fakeEnv();
  const impl = async (url) => {
    if (String(url).includes('oauth2/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        itemSummaries: [
          { price: { value: '999' }, conditionId: '1500', condition: 'Open box' },
          { price: { value: '5' }, conditionId: '7000', condition: 'For parts or not working' },
          { price: { value: '200' }, conditionId: '3000', condition: 'Used' },
        ],
      }),
    };
  };
  const comp = await fetchComps(env, { product_key: 'x', query: 'x' }, impl);
  assert.equal(comp.retail_price, null);
  assert.equal(comp.active_median, 200);
  assert.equal(comp.n_active, 1);
});
