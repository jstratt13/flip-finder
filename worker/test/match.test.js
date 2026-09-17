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
  assert.equal(a.query, 'sony wh-1000xm4 headphone');
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

// Matcher v3 (identity.js). Cases from the 360 stored listings, Sept 2026.
test('generation numbers stay in the key; capacity and colour do not replace them', () => {
  // v2 keyed both as "64gb-black-factory-iphone": the 13 got the 12's comps.
  const a = matchProduct('iPhone 12 64GB Black factory unlocked');
  const b = matchProduct('iPhone 13 64GB Black factory unlocked');
  assert.notEqual(a.product_key, b.product_key);
  assert.equal(matchProduct('iPhone 13 64GB Blue').product_key, b.product_key);
  assert.notEqual(matchProduct('iPhone 13 256GB').product_key, b.product_key);
  assert.notEqual(matchProduct('iPhone 13 Pro 64GB').product_key, b.product_key);
});

test('named products with a generation are not too vague', () => {
  for (const t of ['Air Jordan 4 retro OG Fire Red 2020 size 10', 'Litter Robot 3', 'iPhone 7 Plus, 256 GB', 'POLK AUDIO PSW 505 12" POWERED SUBWOOFER']) {
    assert.ok(matchProduct(t).match_score >= 0.7, t);
  }
});

test('a size, wattage or resolution is not a model code', () => {
  assert.equal(matchProduct('Media Streamer 4K').match_score, 0.3);
  const onkyo = matchProduct('Monster vintage Onkyo TX-SV515Pro 80W Receiver');
  assert.equal(onkyo.product_key, matchProduct('Onkyo TX-SV515Pro receiver').product_key);
  assert.equal(onkyo.match_score, 0.9);
});

test('spellings of one brand share a key', () => {
  assert.equal(matchProduct('Polk Audio PSW505 subwoofer').product_key, matchProduct('Polk PSW 505').product_key);
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

test('one search per product asks for every resale condition but parts', async () => {
  const env = fakeEnv();
  const f = fakeFetch([400], [200]);
  await fetchComps(env, { product_key: 'x', query: 'x' }, f.impl);

  const searches = f.calls.filter((u) => u.includes('item_summary/search'));
  assert.equal(searches.length, 1, 'still one call per product');
  const filter = decodeURIComponent(searches[0]);
  // Open box and the refurbished grades are real resale comps and used to be
  // discarded: 16 of 44 relevant results for one iPhone 12.
  for (const id of ['1000', '1500', '2000', '2010', '2020', '2030', '2500', '3000']) {
    assert.ok(filter.includes(id), `condition ${id} should be requested`);
  }
  assert.ok(!filter.includes('7000'), 'for parts is never a comp');
  assert.equal(new URL(searches[0]).searchParams.get('limit'), '50');
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

test('each condition lands on the side that matches what a buyer gets', async () => {
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
          // Pristine side: what a like-new local listing competes with.
          { price: { value: '300' }, conditionId: '1500', condition: 'Open box' },
          { price: { value: '290' }, conditionId: '2010', condition: 'Excellent - Refurbished' },
          { price: { value: '310' }, conditionId: '1000', condition: 'New' },
          // Working side: a "Good - Refurbished" phone is a tidied-up used one.
          { price: { value: '200' }, conditionId: '3000', condition: 'Used' },
          { price: { value: '210' }, conditionId: '2030', condition: 'Good - Refurbished' },
          { price: { value: '190' }, conditionId: '2500', condition: 'Seller refurbished' },
          // Never a comp, whatever else is on the page.
          { price: { value: '5' }, conditionId: '7000', condition: 'For parts or not working' },
        ],
      }),
    };
  };
  const comp = await fetchComps(env, { product_key: 'x', query: 'x' }, impl);
  assert.equal(comp.n_new, 3, 'new, open box and excellent refurbished');
  assert.equal(comp.retail_price, 300);
  assert.equal(comp.n_active, 3, 'used, good refurbished and seller refurbished');
  assert.equal(comp.active_median, 200);
  assert.ok(comp.new_p25 > 0 && comp.new_p75 > 0, 'the pristine side carries its own spread');
});

test('comps are built only from results that are the listing product', async () => {
  const env = fakeEnv();
  const { identity } = await import('../src/identity.js');
  const impl = async (url) => {
    if (String(url).includes('oauth2/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) };
    }
    // Shapes seen in the Sept 2026 sample for "Apple iPhone 13 128GB".
    const item = (title, price, conditionId = '3000') => ({ title, price: { value: String(price) }, conditionId });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        itemSummaries: [
          item('Apple iPhone 13 A2482 128GB Midnight Unlocked', 230),
          item('Apple iPhone 13 128GB Blue - Good', 240),
          item('Apple iPhone 13 - 128 GB - Midnight (Unlocked)', 250),
          item('Apple iPhone 14 128GB Midnight', 330),            // different generation
          item('Apple iPhone 13 Pro 128GB Graphite', 380),       // different variant
          item('Case for Apple iPhone 13 Midnight', 12),         // accessory
          item('Apple iPhone 12 64/128GB Fully Unlocked', 180),  // different generation
        ],
      }),
    };
  };
  const comp = await fetchComps(
    env,
    { product_key: 'k', query: 'apple iphone 13 128gb', identity: identity('Apple iPhone 13 - 128GB - Midnight') },
    impl
  );
  assert.equal(comp.n_results, 7);
  assert.equal(comp.n_relevant, 3);
  assert.equal(comp.filtered, 1);
  assert.equal(comp.n_active, 3);
  assert.equal(comp.active_median, 240);
});

test('without an identity every result counts, as before', async () => {
  const env = fakeEnv();
  const f = fakeFetch([400], [200, 210]);
  const comp = await fetchComps(env, { product_key: 'x', query: 'x' }, f.impl);
  assert.equal(comp.filtered, 0);
  assert.equal(comp.n_relevant, comp.n_results);
});

test('a brand alone, or a brand that is an ordinary word, does not name a product', () => {
  assert.equal(matchProduct("Women's Nike").match_score, 0.3);
  assert.equal(matchProduct('Moving Sale! Ping Pong Table with Paddles and Net', 'furniture').brand, null);
  assert.equal(matchProduct('Air Jordan 4 retro OG Fire Red 2020 size 10').match_score, 0.9);
});

test('comps are delivered prices: item plus its shipping', async () => {
  const env = fakeEnv();
  // Two used listings: same delivered price, advertised differently.
  const impl = async (url) => {
    if (String(url).includes('oauth2/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 7200 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        itemSummaries: [
          { itemId: '1', title: 'thing', price: { value: '20' }, conditionId: '3000', condition: 'Used',
            shippingOptions: [{ shippingCost: { value: '15' } }] },
          { itemId: '2', title: 'thing', price: { value: '35' }, conditionId: '3000', condition: 'Used',
            shippingOptions: [{ shippingCost: { value: '0' } }] },
          { itemId: '3', title: 'thing', price: { value: '35' }, conditionId: '3000', condition: 'Used',
            shippingOptions: [{ shippingCost: { value: '0' } }] },
        ],
      }),
    };
  };

  const comp = await fetchComps(env, { product_key: 'x', query: 'x' }, impl);
  assert.equal(comp.active_median, 35, 'the $20 + $15 listing is a $35 comp');
});
