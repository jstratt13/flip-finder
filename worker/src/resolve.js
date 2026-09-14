import { matchProduct } from './match.js';
import { fetchComps } from './ebay.js';
import { fetchLocalComps } from './localcomps.js';
import { scoreListing } from './score.js';
import { FRESHNESS } from './config.js';
import { allIn } from './d1.js';

// eBay Browse allows roughly 5k calls/day and each product costs two, so cap
// how many fresh lookups one run can trigger. Cached products, and local comps
// (which are just a D1 query), are unlimited.
const MAX_COMP_FETCHES = 40;

// A listing that failed to price (eBay down, rate limited, no comps yet) gets a
// score row with a null score. Without a retry window it would never be looked
// at again, so a transient outage would silently drop it forever.
const RETRY_UNSCORED_MS = 6 * 60 * 60 * 1000;

const isLocalKey = (k) => k.startsWith('local:');

function upsertComp(db, c) {
  return db
    .prepare(
      `INSERT INTO comps (product_key, retail_price, active_median, active_p25, active_p75,
                          n_active, source, fetched_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (product_key) DO UPDATE SET
         retail_price = excluded.retail_price,
         active_median = excluded.active_median,
         active_p25 = excluded.active_p25,
         active_p75 = excluded.active_p75,
         n_active = excluded.n_active,
         source = excluded.source,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`
    )
    .bind(
      c.product_key, c.retail_price, c.active_median, c.active_p25, c.active_p75,
      c.n_active, c.source, c.fetched_at, c.expires_at
    );
}

// Listings that have gone unseen long enough to be treated as removed. Uses
// last_seen rather than first_seen deliberately: an item you re-encounter every
// week is demonstrably still listed no matter how old the post is.
export async function sweepStale(db, now = Date.now()) {
  const cutoff = now - FRESHNESS.gone_after_days * 24 * 60 * 60 * 1000;
  const { meta } = await db
    .prepare("UPDATE listings SET status = 'gone' WHERE status = 'active' AND last_seen < ?")
    .bind(cutoff)
    .run();
  return meta?.changes ?? 0;
}

export async function resolvePending(
  env,
  { limit = 200, fetchImpl = fetch, retryUnscoredMs = RETRY_UNSCORED_MS } = {}
) {
  const db = env.DB;
  const now = Date.now();

  // Cheap, and keeps dead listings from accumulating at the top of the ranking.
  const swept = await sweepStale(db, now);

  const { results: pending } = await db
    .prepare(
      `SELECT l.id, l.title, l.price, l.acquisition_mode, l.inbound_ship,
              l.distance_mi, l.category
       FROM listings l
       LEFT JOIN scores s ON s.listing_id = l.id
       WHERE l.status = 'active' AND l.price IS NOT NULL
         AND (s.listing_id IS NULL OR (s.score IS NULL AND s.computed_at <= ?))
       ORDER BY l.last_seen DESC
       LIMIT ?`
    )
    .bind(now - retryUnscoredMs, limit)
    .all();

  if (!pending.length) {
    return { pending: 0, matched: 0, scored: 0, comp_fetches: 0, local_comps: 0, swept };
  }

  const matches = new Map();
  for (const l of pending) {
    const m = matchProduct(l.title, l.category ?? '');
    if (m) matches.set(l.id, m);
  }

  // Matches are persisted before comps are computed: local comps are derived
  // from listing_matches, so this batch has to be visible to its own query or
  // every bulky listing would be priced against a pool missing its peers.
  const matchStmts = [];
  for (const [listingId, m] of matches) {
    const listing = pending.find((l) => l.id === listingId);
    matchStmts.push(
      db
        .prepare(
          `INSERT INTO listing_matches (listing_id, product_key, match_score, method, matched_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT (listing_id) DO UPDATE SET
             product_key = excluded.product_key, match_score = excluded.match_score,
             method = excluded.method, matched_at = excluded.matched_at`
        )
        .bind(listingId, m.product_key, m.match_score, m.method, now)
    );
    matchStmts.push(
      db
        .prepare(
          `INSERT INTO products (product_key, brand, model, category, canonical_title, created_at)
           VALUES (?,?,?,?,?,?) ON CONFLICT (product_key) DO NOTHING`
        )
        .bind(m.product_key, m.brand, m.model, listing?.category ?? null, listing?.title ?? null, now)
    );
  }
  if (matchStmts.length) await db.batch(matchStmts);

  const keys = [...new Set([...matches.values()].map((m) => m.product_key))];

  const compByKey = new Map();
  const cached = await allIn(
    db,
    (ph) => `SELECT * FROM comps WHERE product_key IN (${ph}) AND expires_at > ?`,
    keys,
    [now]
  );
  for (const c of cached) compByKey.set(c.product_key, c);

  const staleKeys = keys.filter((k) => !compByKey.has(k));
  const queryFor = new Map([...matches.values()].map((m) => [m.product_key, m.query]));

  let localComps = 0;
  const needsEbayFallback = [];

  for (const key of staleKeys.filter(isLocalKey)) {
    const comp = await fetchLocalComps(db, { product_key: key });

    // Cold start: until enough local listings accumulate there is nothing to
    // compare against, so fall back to eBay rather than leaving bulky items
    // permanently unpriced. The venue mix stays local either way.
    if (comp.active_median == null) {
      needsEbayFallback.push(key);
      continue;
    }

    compByKey.set(key, comp);
    await upsertComp(db, comp).run();
    localComps += 1;
  }

  let fetches = 0;
  const ebayKeys = [...staleKeys.filter((k) => !isLocalKey(k)), ...needsEbayFallback];

  for (const key of ebayKeys.slice(0, MAX_COMP_FETCHES)) {
    try {
      const comp = await fetchComps(env, { product_key: key, query: queryFor.get(key) }, fetchImpl);
      compByKey.set(key, comp);
      await upsertComp(db, comp).run();
      fetches += 1;
    } catch (err) {
      // Rate limiting or an outage shouldn't abort the run; the rest of the
      // batch still scores against cached comps.
      if (String(err.message).includes('rate limited')) break;
    }
  }

  const conditions = await allIn(
    db,
    (ph) => `SELECT listing_id, band, multiplier, confidence FROM conditions WHERE listing_id IN (${ph})`,
    pending.map((l) => l.id)
  );
  const condById = new Map(conditions.map((c) => [c.listing_id, c]));

  const scoreStmts = [];
  let scored = 0;

  for (const listing of pending) {
    const match = matches.get(listing.id);
    if (!match) continue;

    const s = scoreListing({
      listing,
      comp: compByKey.get(match.product_key) ?? null,
      condition: condById.get(listing.id),
      match,
    });

    if (s.score != null) scored += 1;

    scoreStmts.push(
      db
        .prepare(
          `INSERT INTO scores (listing_id, anchor_value, anchor_source, est_net_fb, est_net_ebay,
                               est_net_blended, acquisition_cost, profit, roi, confidence, score, computed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (listing_id) DO UPDATE SET
             anchor_value = excluded.anchor_value, anchor_source = excluded.anchor_source,
             est_net_fb = excluded.est_net_fb, est_net_ebay = excluded.est_net_ebay,
             est_net_blended = excluded.est_net_blended, acquisition_cost = excluded.acquisition_cost,
             profit = excluded.profit, roi = excluded.roi, confidence = excluded.confidence,
             score = excluded.score, computed_at = excluded.computed_at`
        )
        .bind(
          s.listing_id, s.anchor_value, s.anchor_source, s.est_net_fb, s.est_net_ebay,
          s.est_net_blended, s.acquisition_cost, s.profit, s.roi, s.confidence, s.score, s.computed_at
        )
    );
  }

  if (scoreStmts.length) await db.batch(scoreStmts);

  return {
    pending: pending.length,
    matched: matches.size,
    scored,
    comp_fetches: fetches,
    local_comps: localComps,
    swept,
    products: keys.length,
  };
}
