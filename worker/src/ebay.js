import { summarize, percentile } from './stats.js';
import { judgeResult } from './identity.js';

const OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

// eBay's condition ids, grouped the way a local listing's condition maps onto
// them. "For parts or not working" (7000) is deliberately absent: those
// listings are refused at ingest and say nothing about a working item's value.
//
// The split is by what a buyer is getting, not by eBay's label: an "Excellent -
// Refurbished" phone competes with a like-new private sale, while a "Good -
// Refurbished" one is a used phone someone cleaned up. Before this, only 1000
// and 3000 were requested at all — for one iPhone 12, that discarded 16 of 44
// relevant listings, every refurbished and open-box comp on the page.
export const CONDITION = {
  // Sets the value for a local listing in new or like-new condition.
  PRISTINE: ['1000', '1500', '2000', '2010', '2020'],
  // ...and for everything else still working: good, fair.
  WORKING: ['2030', '2500', '3000'],
};
CONDITION.ALL = [...CONDITION.PRISTINE, ...CONDITION.WORKING];

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
// the text is a fallback in case a summary arrives without one.
function sideOf(item) {
  if (item.conditionId != null) {
    if (CONDITION.PRISTINE.includes(item.conditionId)) return 'new';
    if (CONDITION.WORKING.includes(item.conditionId)) return 'used';
    return null;
  }
  const text = item.condition ?? '';
  if (/^new$/i.test(text) || /open box/i.test(text) || /(certified|excellent|very good)\s*-?\s*refurbished/i.test(text)) return 'new';
  if (/^(used|pre-owned)$/i.test(text) || /(good|seller)\s*-?\s*refurbished/i.test(text)) return 'used';
  return null;
}

// Results for one search, split into the retail anchor and the used signal.
// Parsing the page is the largest CPU cost of pricing a product on a plan that
// allows 10 ms per run: 100 items measured ~0.5 ms per product, 50 about half.
const COMP_PAGE_SIZE = 50;

// One call per product: new and used listings come back in a single search and
// are split by condition. The new-condition median is the retail anchor, the
// used median the resale signal. This halves eBay calls against the daily
// allowance. The trade is that one page shared between both conditions can be
// mostly one of them; with too few new listings the retail anchor comes back
// null and scoring falls back to the used median alone, as it always has when
// one side was missing. Cached by product_key so many listings of the same item
// cost one lookup.
export async function fetchComps(env, { product_key, query, token, identity: id }, fetchImpl = fetch) {
  // A failed search throws: "couldn't search" must never be cached as "found
  // nothing", or retries would be suppressed long after an outage ends.
  const items = await search(
    env,
    { query, conditionIds: CONDITION.ALL, limit: COMP_PAGE_SIZE, token },
    fetchImpl
  );
  // Only results that are the listing's product count. Production's searches
  // used to return mostly other models and accessories: in the Sept 2026 eBay
  // sample, 16–30% of results for model-code titles were the product. When the
  // identity names nothing checkable (no brand, code or generation), every
  // result is kept, as before.
  const kept = id ? items.filter((i) => judgeResult(i.title, id).relevant !== false) : items;
  const newItems = kept.filter((i) => sideOf(i) === 'new');
  const usedItems = kept.filter((i) => sideOf(i) === 'used');

  // Both sides are resale listings; they differ only in the condition of what
  // is being resold. score.js picks the side that matches the local item.
  //
  // Delivered price, not item price: a $20 part with $15 postage competes with
  // a $35 one that ships free, and eBay's own buyers compare the total. Taking
  // the item price alone understated small items — the side of the market where
  // shipping is most of the cost — while scoring still subtracted our own
  // outbound shipping from the sale, charging the freight twice.
  const delivered = (i) => i.price + (Number.isFinite(i.shipping) ? i.shipping : 0);
  const retail = summarize(newItems.map(delivered));
  const used = summarize(usedItems.map(delivered));

  const now = Date.now();
  const empty = retail.median == null && used.median == null;

  return {
    product_key,
    retail_price: retail.median,
    active_median: used.median,
    active_p25: used.p25,
    active_p75: used.p75,
    n_active: used.n,
    n_new: retail.n,
    new_p25: retail.p25,
    new_p75: retail.p75,
    source: 'ebay',
    n_results: items.length,
    n_relevant: kept.length,
    filtered: id ? 1 : 0,
    fetched_at: now,
    // A product with no comps at all may pick some up later, so re-check it
    // sooner than one we successfully priced.
    expires_at: now + (empty ? EMPTY_COMP_TTL_MS : COMP_TTL_MS),
  };
}

export const _internal = { summarize, percentile };
