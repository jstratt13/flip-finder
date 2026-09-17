import { summarize } from './stats.js';
import { MIN_LOCAL_COMPS } from './config.js';

// Local asks move with the local market, and recomputing costs one D1 query
// rather than an API call, so these expire far sooner than eBay comps.
const LOCAL_COMP_TTL_MS = 12 * 60 * 60 * 1000;
const RECENCY_MS = 60 * 24 * 60 * 60 * 1000;

// For bulky goods the comparable is what similar items are asking locally, not
// what eBay shows — furniture sells locally precisely because shipping it is
// impractical, so eBay's thin furniture listings are the wrong market.
//
// The pool includes the listing being priced. With a shared cache we can't
// exclude it per-listing, but the median is robust to one member and the bias
// runs conservative: a bargain drags the median toward itself, understating its
// own profit rather than inflating it.
export async function fetchLocalComps(db, { product_key }) {
  // Read from market_observations, not listings: every capture lands there,
  // including the ones ingest refused. Those refusals are rules about what
  // Jordan would buy — no stated condition, outside his price range — not
  // about what the local market is asking, and they are most of what is
  // browsed. Listings that were accepted are in this table too.
  //
  // Parts listings are the exception: a broken one's asking price says nothing
  // about a working one's value.
  const { results } = await db
    .prepare(
      `SELECT price
       FROM market_observations
       WHERE product_key = ?
         AND price > 0
         AND condition_band IS NOT 'parts'
         AND last_seen >= ?`
    )
    .bind(product_key, Date.now() - RECENCY_MS)
    .all();

  const s = summarize(results.map((r) => r.price));
  const now = Date.now();
  const enough = s.n >= MIN_LOCAL_COMPS;

  return {
    product_key,
    // No retail anchor exists for a used sofa; the local market is the anchor.
    retail_price: null,
    active_median: enough ? s.median : null,
    active_p25: enough ? s.p25 : null,
    active_p75: enough ? s.p75 : null,
    n_active: s.n,
    source: 'local',
    fetched_at: now,
    expires_at: now + LOCAL_COMP_TTL_MS,
  };
}
