import { matchProduct, MATCHER_VERSION } from './match.js';
import { fetchComps, getToken } from './ebay.js';
import { fetchLocalComps } from './localcomps.js';
import { scoreListing } from './score.js';
import { FRESHNESS } from './config.js';
import { allIn, chunk, placeholders } from './d1.js';
import { createMeter, metered } from './budget.js';

// eBay Browse allows 5,000 calls a day and each product costs one search. At
// one run every 5 minutes the subrequest budget alone would allow far more, so
// each run counts the last 24 hours of lookups and stops at 4,500, leaving
// margin for failed calls, which leave no comp row behind to be counted.
const EBAY_DAILY_CALLS = 4500;
const EBAY_CALLS_PER_PRODUCT = 1;
const MAX_COMP_FETCHES = 40;

// Subrequests each pricing step costs, used to stop before the budget runs out.
// Comp writes ride in the final score batch, so they cost nothing here.
// Local: the pool query. eBay: the one search. The token is fetched once per
// run — a cache read, plus the OAuth fetch and cache write when it has expired.
const COST_LOCAL = 1;
const COST_EBAY = 1;
const COST_EBAY_TOKEN = 3;

// Listings matched and scored per run. The free plan gives a cron run 10 ms of
// CPU and production runs measured 17–31 ms, most of it a fixed cold-start
// cost; each listing adds ~0.05 ms, so 50 instead of 100 saves ~2 ms. Pricing
// is capped at 16 products a run by the subrequest budget, which 50 listings
// comfortably feeds.
const DEFAULT_LIMIT = 50;

const HOUR = 60 * 60 * 1000;

// When a listing that couldn't be priced is looked at again. Retrying every
// 6 hours forever rewrote the same rows four times a day per stuck listing,
// which is what threatens D1's daily write limit as a backlog grows.
//
// Only a real attempt advances the schedule: no product match, or comps that
// were in hand and still gave no score. Missing credentials, an eBay outage
// or rate limiting say nothing about the listing, so those retry at the first
// step and never push a listing out to three days while credentials are pending.
const RETRY_AFTER_MS = [6 * HOUR, 24 * HOUR, 72 * HOUR];
export const retryDelay = (attempts) => RETRY_AFTER_MS[Math.min(Math.max(attempts, 1), RETRY_AFTER_MS.length) - 1];

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

const UPSERT_MATCH_SQL = `INSERT INTO listing_matches
     (listing_id, product_key, match_score, method, matched_at, matcher_version)
   VALUES (?,?,?,?,?,?)
   ON CONFLICT (listing_id) DO UPDATE SET
     product_key = excluded.product_key, match_score = excluded.match_score,
     method = excluded.method, matched_at = excluded.matched_at,
     matcher_version = excluded.matcher_version`;

// Redo matches made by an older matcher. Scores are only ever computed for
// unscored listings, so without this a matcher fix would never touch anything
// already in the ranking.
//
// A key change moves a listing between local comp pools, which changes the
// median for everyone left in the old pool and everyone joining the new one.
// So every local key touched has its cached comp dropped and every listing in
// it has its score dropped; the scoring pass below then prices them afresh.
// Local comps are one D1 query each, so this costs no eBay calls. eBay-keyed
// listings whose key changed are rescored too, but untouched eBay pools aren't.
//
// Bounded like the rest of the run. If a pool's members land in different
// batches it is invalidated once per batch and settles on the last one.
export async function rematchOutdated(db, { limit = 200, now = Date.now() } = {}) {
  const { results: outdated } = await db
    .prepare(
      `SELECT l.id, l.title, l.category, m.product_key AS old_key
       FROM listing_matches m
       JOIN listings l ON l.id = m.listing_id
       WHERE m.matcher_version < ? AND l.status = 'active'
       LIMIT ?`
    )
    .bind(MATCHER_VERSION, limit)
    .all();

  if (!outdated.length) return { rematched: 0, changed: 0 };

  const stmts = [];
  const touchedLocal = new Set();
  const changedIds = [];

  for (const l of outdated) {
    const m = matchProduct(l.title, l.category ?? '');
    const newKey = m?.product_key ?? null;

    if (newKey !== l.old_key) {
      changedIds.push(l.id);
      if (l.old_key.startsWith('local:')) touchedLocal.add(l.old_key);
      if (newKey?.startsWith('local:')) touchedLocal.add(newKey);
    }

    stmts.push(
      m
        ? db.prepare(UPSERT_MATCH_SQL).bind(l.id, m.product_key, m.match_score, m.method, now, MATCHER_VERSION)
        // No longer matches at all. Leaving the old row would keep it in a
        // local pool it no longer belongs to.
        : db.prepare('DELETE FROM listing_matches WHERE listing_id = ?').bind(l.id)
    );
  }

  for (const pools of chunk([...touchedLocal])) {
    const ph = placeholders(pools);
    stmts.push(db.prepare(`DELETE FROM comps WHERE product_key IN (${ph})`).bind(...pools));
    stmts.push(
      db
        .prepare(
          `UPDATE listings SET score_due_at = ?, score_attempts = 0 WHERE status = 'active' AND id IN
             (SELECT listing_id FROM listing_matches WHERE product_key IN (${ph}))`
        )
        .bind(now, ...pools)
    );
    stmts.push(
      db
        .prepare(
          `DELETE FROM scores WHERE listing_id IN
             (SELECT listing_id FROM listing_matches WHERE product_key IN (${ph}))`
        )
        .bind(...pools)
    );
  }
  for (const ids of chunk(changedIds)) {
    stmts.push(db.prepare(`DELETE FROM scores WHERE listing_id IN (${placeholders(ids)})`).bind(...ids));
    stmts.push(
      db
        .prepare(`UPDATE listings SET score_due_at = ?, score_attempts = 0 WHERE id IN (${placeholders(ids)})`)
        .bind(now, ...ids)
    );
  }

  // One batch, in order: the pool-wide score delete must see the new keys.
  await db.batch(stmts);
  return { rematched: outdated.length, changed: changedIds.length };
}

// Listings that have gone unseen long enough to be treated as removed. Uses
// last_seen rather than first_seen deliberately: an item you re-encounter every
// week is demonstrably still listed no matter how old the post is.
export async function sweepStale(db, now = Date.now()) {
  const cutoff = now - FRESHNESS.gone_after_days * 24 * 60 * 60 * 1000;
  const { meta } = await db
    // Gone listings leave the scoring queue too, keeping its index small.
    .prepare("UPDATE listings SET status = 'gone', score_due_at = NULL WHERE status = 'active' AND last_seen < ?")
    .bind(cutoff)
    .run();
  return meta?.changes ?? 0;
}

export async function resolvePending(
  rawEnv,
  { limit = DEFAULT_LIMIT, fetchImpl: rawFetch = fetch, ignoreSchedule = false, meter = createMeter() } = {}
) {
  const { env, fetchImpl } = metered(rawEnv, rawFetch, meter);
  const db = env.DB;
  const now = Date.now();

  // Cheap, and keeps dead listings from accumulating at the top of the ranking.
  const swept = await sweepStale(db, now);
  const rematch = await rematchOutdated(db, { limit, now });

  const { results: pending } = await db
    .prepare(
      // Walks the partial due-time index, newest first, and stops at the limit:
      // reads about as many rows as it returns, however large the table grows.
      `SELECT l.id, l.title, l.price, l.acquisition_mode, l.inbound_ship,
              l.distance_mi, l.category, l.score_attempts
       FROM listings l
       WHERE l.score_due_at IS NOT NULL AND l.score_due_at <= ?
         AND l.status = 'active' AND l.price IS NOT NULL
       ORDER BY l.score_due_at DESC
       LIMIT ?`
    )
    .bind(ignoreSchedule ? Number.MAX_SAFE_INTEGER : now, limit)
    .all();

  if (!pending.length) {
    return { pending: 0, matched: 0, scored: 0, comp_fetches: 0, local_comps: 0, swept, rematch, subrequests: meter.used };
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
        .prepare(UPSERT_MATCH_SQL)
        .bind(listingId, m.product_key, m.match_score, m.method, now, MATCHER_VERSION)
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

  // Held back for the calls every run must still make after pricing: the
  // conditions lookup and the batch that saves the scores.
  const reserve = chunk(pending).length + 1;

  // Products the budget didn't reach this run. Their listings get no score row,
  // so they stay pending and are picked up 15 minutes from now rather than
  // parked for the 6-hour retry window as if pricing had failed.
  const deferred = new Set();

  // Without credentials every lookup fails anyway, after reading the token cache
  // twice — enough wasted calls to exhaust the budget on its own. Those listings
  // take the normal "awaiting comps" path instead.
  const ebayConfigured = Boolean(rawEnv.EBAY_CLIENT_ID && rawEnv.EBAY_CLIENT_SECRET);

  // Only asked when this run could actually spend eBay calls.
  let ebayProductsLeft = 0;
  if (ebayConfigured && staleKeys.length) {
    const { results } = await db
      .prepare("SELECT COUNT(*) AS n FROM comps WHERE source = 'ebay' AND fetched_at > ?")
      .bind(now - 24 * HOUR)
      .all();
    const used = (results[0]?.n ?? 0) * EBAY_CALLS_PER_PRODUCT;
    ebayProductsLeft = Math.max(0, Math.floor((EBAY_DAILY_CALLS - used) / EBAY_CALLS_PER_PRODUCT));
  }

  let localComps = 0;
  let fetches = 0;
  let ebayDown = false;

  // Comp writes are collected and saved in the same batch as the scores: one
  // subrequest for all of them instead of one each.
  const compStmts = [];
  let token = null;

  const lookupEbay = async (key) => {
    try {
      token ??= await getToken(env, fetchImpl);
      const comp = await fetchComps(env, { product_key: key, query: queryFor.get(key), token }, fetchImpl);
      compByKey.set(key, comp);
      compStmts.push(upsertComp(db, comp));
    } catch (err) {
      // Rate limiting or an outage shouldn't abort the run; the rest of the
      // batch still scores against cached comps.
      if (String(err.message).includes('rate limited')) ebayDown = true;
    }
    fetches += 1;
  };

  // Each product is taken start to finish, and only started if its worst case
  // fits the budget. Pricing pools first and eBay fallbacks later let a backlog
  // of cold local pools spend the budget on queries that found nothing, defer
  // every fallback, and repeat identically every run — never making progress.
  for (const key of staleKeys) {
    const canEbay = ebayConfigured && !ebayDown && fetches < Math.min(MAX_COMP_FETCHES, ebayProductsLeft);
    // Until this run holds a token, a lookup may also have to fetch one.
    const ebayCost = COST_EBAY + (token ? 0 : COST_EBAY_TOKEN);
    const worst = isLocalKey(key) ? COST_LOCAL + (canEbay ? ebayCost : 0) : canEbay ? ebayCost : 0;

    if (worst && !meter.canSpend(worst, reserve)) {
      deferred.add(key);
      continue;
    }

    if (isLocalKey(key)) {
      const comp = await fetchLocalComps(db, { product_key: key });
      if (comp.active_median != null) {
        compByKey.set(key, comp);
        compStmts.push(upsertComp(db, comp));
        localComps += 1;
        continue;
      }
      // Cold start: until enough local listings accumulate there is nothing to
      // compare against, so fall back to eBay rather than leaving bulky items
      // permanently unpriced. The venue mix stays local either way.
    }

    if (canEbay) await lookupEbay(key);
  }

  const conditions = await allIn(
    db,
    (ph) => `SELECT listing_id, band, multiplier, confidence FROM conditions WHERE listing_id IN (${ph})`,
    pending.map((l) => l.id)
  );
  const condById = new Map(conditions.map((c) => [c.listing_id, c]));

  const scoreStmts = [];
  let scored = 0;

  // Where each listing goes in the queue next. Rides in the final batch.
  const schedule = (listing, { done, attempted }) => {
    const attempts = attempted ? (listing.score_attempts ?? 0) + 1 : listing.score_attempts ?? 0;
    return db
      .prepare('UPDATE listings SET score_due_at = ?, score_attempts = ? WHERE id = ?')
      .bind(done ? null : now + retryDelay(attempts), done ? 0 : attempts, listing.id);
  };

  for (const listing of pending) {
    const match = matches.get(listing.id);
    if (!match) {
      // Nothing to price against. Used to be retried on every single run.
      scoreStmts.push(schedule(listing, { done: false, attempted: true }));
      continue;
    }
    // Left due: the next run picks it up.
    if (deferred.has(match.product_key)) continue;

    const s = scoreListing({
      listing,
      comp: compByKey.get(match.product_key) ?? null,
      condition: condById.get(listing.id),
      match,
    });

    if (s.score != null) scored += 1;
    scoreStmts.push(
      schedule(listing, { done: s.score != null, attempted: compByKey.has(match.product_key) })
    );

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

  const writes = [...compStmts, ...scoreStmts];
  if (writes.length) await db.batch(writes);

  return {
    pending: pending.length,
    matched: matches.size,
    scored,
    comp_fetches: fetches,
    local_comps: localComps,
    swept,
    rematch,
    products: keys.length,
    deferred: deferred.size,
    subrequests: meter.used,
  };
}
