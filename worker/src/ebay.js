import { summarize, percentile } from './stats.js';

const OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

export const CONDITION = { NEW: '1000', USED: '3000' };

const COMP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_COMP_TTL_MS = 24 * 60 * 60 * 1000;


// Comp lookups fire two searches concurrently, so without this the first
// product of every run pays for two identical token requests.
let inflight = null;

export async function getToken(env, fetchImpl = fetch) {
  const cached = await env.CACHE?.get('ebay:token', { type: 'json' });
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.token;

  if (inflight) return inflight;

  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error('eBay credentials not configured');
  }

  inflight = (async () => {
    const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
    const res = await fetchImpl(OAUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    });

    if (!res.ok) throw new Error(`ebay oauth ${res.status}`);

    const body = await res.json();
    const token = body.access_token;
    const ttl = body.expires_in ?? 7200;

    await env.CACHE?.put(
      'ebay:token',
      JSON.stringify({ token, expires_at: Date.now() + ttl * 1000 }),
      { expirationTtl: Math.max(120, Math.floor(ttl - 120)) }
    );

    return token;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export async function search(env, { query, conditionId, limit = 50 }, fetchImpl = fetch) {
  const token = await getToken(env, fetchImpl);
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('filter', `conditionIds:{${conditionId}},buyingOptions:{FIXED_PRICE}`);

  const res = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });

  if (res.status === 429) throw new Error('ebay rate limited');
  if (!res.ok) throw new Error(`ebay search ${res.status}`);

  const body = await res.json();
  return (body.itemSummaries ?? []).map((it) => ({
    id: it.itemId,
    title: it.title,
    price: Number(it.price?.value),
    condition: it.condition,
    url: it.itemWebUrl,
    shipping: Number(it.shippingOptions?.[0]?.shippingCost?.value ?? 0),
  }));
}

// Two calls per product: new-condition median is the retail anchor, used median
// is the resale signal. Cached by product_key so many listings of the same item
// cost one lookup.
export async function fetchComps(env, { product_key, query }, fetchImpl = fetch) {
  let newErr = null;
  let usedErr = null;

  const [newItems, usedItems] = await Promise.all([
    search(env, { query, conditionId: CONDITION.NEW }, fetchImpl).catch((e) => {
      newErr = e;
      return [];
    }),
    search(env, { query, conditionId: CONDITION.USED }, fetchImpl).catch((e) => {
      usedErr = e;
      return [];
    }),
  ]);

  // "Searched and found nothing" is a result worth caching. "Couldn't search"
  // is not — caching that would suppress retries long after the outage ends.
  if (newErr && usedErr) throw newErr;

  const retail = summarize(newItems.map((i) => i.price));
  const used = summarize(usedItems.map((i) => i.price));

  const now = Date.now();
  const empty = retail.median == null && used.median == null;

  return {
    product_key,
    retail_price: retail.median,
    active_median: used.median,
    active_p25: used.p25,
    active_p75: used.p75,
    n_active: used.n,
    source: 'ebay',
    fetched_at: now,
    // A product with no comps at all may pick some up later, so re-check it
    // sooner than one we successfully priced.
    expires_at: now + (empty ? EMPTY_COMP_TTL_MS : COMP_TTL_MS),
  };
}

export const _internal = { summarize, percentile };
