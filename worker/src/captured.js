// Everything captured, with why each one isn't in the ranking.
//
// Without this the dashboard looks identical whether nothing good turned up
// today or capture broke three weeks ago. The reason per listing is the whole
// point — "no product match" and "awaiting comps" call for very different
// responses, and neither is visible from an empty Opportunities tab.

export function rankingReason(r, gates) {
  if (r.acquired) return { code: 'acquired', label: 'Bought' };
  if (r.status !== 'active') return { code: 'gone', label: 'No longer listed' };
  if (r.price == null) return { code: 'no_price', label: 'No price' };
  if (!r.product_key) return { code: 'no_match', label: 'No product match' };
  if (r.active_median == null && r.retail_price == null) {
    return { code: 'no_comps', label: 'Awaiting comps' };
  }
  if (r.score == null) {
    return { code: 'no_margin', label: 'No margin at this price' };
  }
  if (r.profit < gates.min_profit) {
    return { code: 'low_profit', label: `Profit $${Math.round(r.profit)}` };
  }
  if (r.confidence < gates.min_confidence) {
    return { code: 'low_confidence', label: `Confidence ${r.confidence.toFixed(2)}` };
  }
  if (r.roi < gates.min_roi) {
    return { code: 'low_roi', label: `ROI ${Math.round(r.roi * 100)}%` };
  }
  return { code: 'ranking', label: 'In the ranking' };
}

export const REASON_CODES = [
  'acquired', 'gone', 'no_price', 'no_match', 'no_comps',
  'no_margin', 'low_profit', 'low_confidence', 'low_roi', 'ranking',
];

// rankingReason, in SQL. Filtering by reason has to happen in the query: the
// page returns the latest 200 listings, so tallying or filtering in JavaScript
// only ever described those 200, not everything captured. The two must agree
// branch for branch — test/captured.test.js runs both over the same rows.
// Binds three gates, in order: min_profit, min_confidence, min_roi.
const REASON_SQL = `
  CASE
    WHEN EXISTS (SELECT 1 FROM acquisitions a WHERE a.listing_id = l.id) THEN 'acquired'
    WHEN l.status IS NOT 'active' THEN 'gone'
    WHEN l.price IS NULL THEN 'no_price'
    WHEN m.product_key IS NULL OR m.product_key = '' THEN 'no_match'
    WHEN cp.active_median IS NULL AND cp.retail_price IS NULL THEN 'no_comps'
    WHEN s.score IS NULL THEN 'no_margin'
    WHEN s.profit < ? THEN 'low_profit'
    WHEN s.confidence < ? THEN 'low_confidence'
    WHEN s.roi < ? THEN 'low_roi'
    ELSE 'ranking'
  END`;

const FROM = `
  FROM listings l
  LEFT JOIN conditions c ON c.listing_id = l.id
  LEFT JOIN listing_matches m ON m.listing_id = l.id
  LEFT JOIN comps cp ON cp.product_key = m.product_key
  LEFT JOIN scores s ON s.listing_id = l.id`;

export async function capturedListings(db, { source, q, reason, limit = 200, gates }) {
  const where = [];
  const binds = [];
  if (source && source !== 'all') {
    where.push('l.source = ?');
    binds.push(source);
  }

  // Free-text search over what was captured. Every term must appear, in either
  // the title or the description — this is for finding one listing you already
  // know about, not for browsing, so narrowing beats recall.
  const terms = (q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  for (const term of terms) {
    where.push("(LOWER(l.title) LIKE ? OR LOWER(COALESCE(l.description, '')) LIKE ?)");
    binds.push(`%${term}%`, `%${term}%`);
  }

  const gateBinds = [gates.min_profit, gates.min_confidence, gates.min_roi];
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Tallies cover every listing matching source and search, not the chosen
  // reason — so the other reasons stay visible to switch to.
  const summaryStmt = db
    .prepare(`SELECT ${REASON_SQL} AS code, COUNT(*) AS n ${FROM} ${whereSql} GROUP BY code`)
    .bind(...gateBinds, ...binds);

  const filtered = REASON_CODES.includes(reason);
  const pageStmt = db
    .prepare(
      `SELECT * FROM (
         SELECT l.id, l.source, l.title, l.price, l.url, l.thumb_url, l.category,
                l.last_seen, l.status, l.distance_mi, l.geo_source, l.acquisition_mode,
                c.band AS condition_band,
                m.product_key, m.match_score,
                cp.active_median, cp.retail_price, cp.n_active,
                s.score, s.profit, s.roi, s.confidence, s.anchor_value, s.anchor_source,
                s.est_net_blended, s.acquisition_cost,
                EXISTS (SELECT 1 FROM acquisitions a WHERE a.listing_id = l.id) AS acquired,
                EXISTS (SELECT 1 FROM watchlist w WHERE w.listing_id = l.id) AS watched,
                ${REASON_SQL} AS reason_code
         ${FROM}
         ${whereSql}
       )
       ${filtered ? 'WHERE reason_code = ?' : ''}
       ORDER BY last_seen DESC
       LIMIT ?`
    )
    .bind(...gateBinds, ...binds, ...(filtered ? [reason] : []), limit);

  const [{ results: counts }, { results: rows }] = await db.batch([summaryStmt, pageStmt]);

  const summary = Object.fromEntries(counts.map((r) => [r.code, r.n]));
  const total = counts.reduce((sum, r) => sum + r.n, 0);
  const listings = rows.map(({ reason_code, ...r }) => ({ ...r, reason: rankingReason(r, gates) }));

  return {
    count: listings.length,
    // How many match the current view in all — more than count when the page
    // is capped, which the dashboard says out loud.
    matching: filtered ? summary[reason] ?? 0 : total,
    total,
    reason: filtered ? reason : null,
    summary,
    listings,
  };
}
