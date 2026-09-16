// Everything captured, with why each one isn't in the ranking.
//
// Without this the dashboard looks identical whether nothing good turned up
// today or capture broke three weeks ago. The reason per listing is the whole
// point — "no product match" and "awaiting comps" call for very different
// responses, and neither is visible from an empty Opportunities tab.

const NEW_BANDS = new Set(['new', 'like_new']);

export function rankingReason(r, gates) {
  if (r.acquired) return { code: 'acquired', label: 'Bought' };
  if (r.status !== 'active') return { code: 'gone', label: 'No longer listed' };
  if (r.price == null) return { code: 'no_price', label: 'No price' };
  if (!r.product_key) return { code: 'no_match', label: 'No product match' };
  if (r.match_score != null && r.match_score < gates.vague_match_below) {
    return { code: 'too_vague', label: 'Too vague to price' };
  }
  if (r.active_median == null && r.retail_price == null) {
    return { code: 'no_comps', label: 'Awaiting comps' };
  }
  // Which side of the comps prices this listing is its own condition's doing —
  // see anchorValue in score.js; the two must agree about what is thin.
  if (r.comp_source !== 'local') {
    const n = NEW_BANDS.has(r.condition_band) && (r.n_new ?? 0) >= gates.min_resale_comps
      ? r.n_new ?? 0
      : r.n_active ?? 0;
    if (n < gates.min_resale_comps) {
      return { code: 'thin_comps', label: `Only ${n} resale comp${n === 1 ? '' : 's'}` };
    }
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
  'acquired', 'gone', 'no_price', 'no_match', 'too_vague', 'no_comps',
  'thin_comps', 'no_margin', 'low_profit', 'low_confidence', 'low_roi', 'ranking',
];

// rankingReason, in SQL. Filtering by reason has to happen in the query: the
// page returns the latest 200 listings, so tallying or filtering in JavaScript
// only ever described those 200, not everything captured. The two must agree
// branch for branch — test/captured.test.js runs both over the same rows.
// Binds six values, in order: vague_match_below, min_resale_comps (twice, for
// the two halves of the condition-side choice), min_profit, min_confidence,
// min_roi.
const REASON_SQL = `
  CASE
    WHEN EXISTS (SELECT 1 FROM acquisitions a WHERE a.listing_id = l.id) THEN 'acquired'
    WHEN l.status IS NOT 'active' THEN 'gone'
    WHEN l.price IS NULL THEN 'no_price'
    WHEN m.product_key IS NULL OR m.product_key = '' THEN 'no_match'
    WHEN m.match_score < ? THEN 'too_vague'
    WHEN cp.active_median IS NULL AND cp.retail_price IS NULL THEN 'no_comps'
    WHEN cp.source IS NOT 'local'
         AND (CASE WHEN c.band IN ('new', 'like_new') AND COALESCE(cp.n_new, 0) >= ?
                   THEN COALESCE(cp.n_new, 0) ELSE COALESCE(cp.n_active, 0) END) < ?
      THEN 'thin_comps'
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

// One page of the Captured tab.
//
// Pages continue from a cursor — the last row's (last_seen, id) — rather than
// an OFFSET. D1 bills every row a query reads, and an offset reads past every
// earlier page first: in production a 50-row page 150 rows deep read 792 rows
// against 192 for the first. With a cursor each page costs about the same.
//
// Tallies scan every listing matching the source and search (1,898 rows read
// at 382 listings) and don't change as you page, so they're counted only when
// asked for — the dashboard asks on the first page and reuses them after.
export const PAGE_SIZE = 50;

export async function capturedListings(
  db,
  { source, q, reason, limit = PAGE_SIZE, cursor = null, tallies = true, gates }
) {
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

  const gateBinds = [
    gates.vague_match_below, gates.min_resale_comps, gates.min_resale_comps,
    gates.min_profit, gates.min_confidence, gates.min_roi,
  ];
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const filtered = REASON_CODES.includes(reason);
  const page = parseCursor(cursor);

  const outer = [];
  const outerBinds = [];
  if (filtered) {
    outer.push('reason_code = ?');
    outerBinds.push(reason);
  }
  if (page) {
    // Ties on last_seen are real: a whole grid batch shares one timestamp.
    // Written as a row value so SQLite seeks idx_listings_seen_id to the
    // cursor; the equivalent OR form scanned from the top of the index.
    outer.push('(last_seen, id) < (?, ?)');
    outerBinds.push(page.lastSeen, page.id);
  }

  const pageStmt = db
    .prepare(
      `SELECT * FROM (
         SELECT l.id, l.source, l.title, l.price, l.url, l.thumb_url, l.category,
                l.last_seen, l.status, l.distance_mi, l.geo_source, l.acquisition_mode,
                c.band AS condition_band,
                m.product_key, m.match_score,
                cp.active_median, cp.retail_price, cp.n_active, cp.n_new, cp.source AS comp_source,
                s.score, s.profit, s.roi, s.confidence, s.anchor_value, s.anchor_source,
                s.est_net_blended, s.acquisition_cost,
                EXISTS (SELECT 1 FROM acquisitions a WHERE a.listing_id = l.id) AS acquired,
                EXISTS (SELECT 1 FROM watchlist w WHERE w.listing_id = l.id) AS watched,
                ${REASON_SQL} AS reason_code
         ${FROM}
         ${whereSql}
       )
       ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
       ORDER BY last_seen DESC, id DESC
       LIMIT ?`
    )
    // One extra row says whether another page exists, without a count query.
    .bind(...gateBinds, ...binds, ...outerBinds, limit + 1);

  // Tallies cover every listing matching source and search, not the chosen
  // reason — so the other reasons stay visible to switch to.
  const summaryStmt = tallies
    ? db
        .prepare(`SELECT ${REASON_SQL} AS code, COUNT(*) AS n ${FROM} ${whereSql} GROUP BY code`)
        .bind(...gateBinds, ...binds)
    : null;

  const results = await db.batch(summaryStmt ? [pageStmt, summaryStmt] : [pageStmt]);
  const rows = results[0].results;
  const more = rows.length > limit;
  const listings = rows
    .slice(0, limit)
    .map(({ reason_code, ...r }) => ({ ...r, reason: rankingReason(r, gates) }));
  const last = listings.at(-1);

  const out = {
    count: listings.length,
    reason: filtered ? reason : null,
    listings,
    next_cursor: more && last ? `${last.last_seen}:${last.id}` : null,
  };

  if (summaryStmt) {
    const counts = results[1].results;
    out.summary = Object.fromEntries(counts.map((r) => [r.code, r.n]));
    out.total = counts.reduce((sum, r) => sum + r.n, 0);
    // How many match the current view in all, for "51–100 of 370".
    out.matching = filtered ? out.summary[reason] ?? 0 : out.total;
  }
  return out;
}

// "<last_seen>:<id>". Ids contain colons themselves ("facebook:123"), so only
// the first one separates. Anything malformed means the first page.
function parseCursor(cursor) {
  const m = /^(\d+):(.+)$/.exec(String(cursor ?? ''));
  return m ? { lastSeen: Number(m[1]), id: m[2] } : null;
}
