import { summarize, percentile } from './stats.js';

const OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

export const CONDITION = { NEW: '1000', USED: '3000' };

const DAY_MS = 24 * 60 * 60 * 1000;

// How long a product's eBay comps are trusted before another lookup. Every
// re-lookup spends from eBay's daily allowance, so longer lifetimes leave more
// of it for new products. The cost is staleness: fast-moving categories (phones,
// GPUs, consoles) can shift meaningfully within two weeks.
const COMP_TTL_MS = 14 * DAY_MS;
// "eBay found nothing" is re-checked sooner — a product can pick up listings —
// but not daily, since most empty results stay empty.
const EMPTY_COMP_TTL_MS = 3 * DAY_MS;


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

// `token` lets a caller fetch it once and reuse it: on the free plan every
// token-cache read is a subrequest, and two per product added up.
export async function search(env, { query, conditionIds, limit = 50, token }, fetchImpl = fetch) {
  token ??= await getToken(env, fetchImpl);
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  // eBay's filter syntax takes several values in one clause, pipe-separated.
  url.searchParams.set('filter', `conditionIds:{${conditionIds.join('|')}},buyingOptions:{FIXED_PRICE}`);

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
    conditionId: it.conditionId != null ? String(it.conditionId) : null,
    url: it.itemWebUrl,
    shipping: Number(it.shippingOptions?.[0]?.shippingCost?.value ?? 0),
  }));
}

// Which side of the comp an item belongs to. The numeric id is authoritative;
// the text is a fallback in case a summary arrives without one. Anything else
// (open box, refurbished) wasn't asked for and is left out rather than guessed.
function sideOf(item) {
  if (item.conditionId === CONDITION.NEW) return 'new';
  if (item.conditionId === CONDITION.USED) return 'used';
  if (item.conditionId == null) {
    if (/^new$/i.test(item.condition ?? '')) return 'new';
    if (/^(used|pre-owned)$/i.test(item.condition ?? '')) return 'used';
  }
  return null;
}

// Results for one search. Both conditions share one page, so this is what the
// retail anchor and the used signal are split from — the same number of items
// the two 50-item searches used to return, which keeps JSON parsing CPU level.
const COMP_PAGE_SIZE = 100;

// One call per product: new and used listings come back in a single search and
// are split by condition. The new-condition median is the retail anchor, the
// used median the resale signal. This halves eBay calls against the daily
// allowance. The trade is that one page shared between both conditions can be
// mostly one of them; with too few new listings the retail anchor comes back
// null and scoring falls back to the used median alone, as it always has when
// one side was missing. Cached by product_key so many listings of the same item
// cost one lookup.
export async function fetchComps(env, { product_key, query, token }, fetchImpl = fetch) {
  // A failed search throws: "couldn't search" must never be cached as "found
  // nothing", or retries would be suppressed long after an outage ends.
  const items = await search(
    env,
    { query, conditionIds: [CONDITION.NEW, CONDITION.USED], limit: COMP_PAGE_SIZE, token },
    fetchImpl
  );
  const newItems = items.filter((i) => sideOf(i) === 'new');
  const usedItems = items.filter((i) => sideOf(i) === 'used');

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
