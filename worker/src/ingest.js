import { HOME, haversineMi, CAPTURE_PRICE } from './config.js';
import { assessCondition } from './condition.js';
import { categorize } from './categorize.js';
import { coordsForCity } from './cities.js';
import { allIn } from './d1.js';

// An unchanged re-capture still refreshes last_seen, but no more than this
// often. Staleness is judged in days (7 to flag, 30 to sweep), so an hour of
// lag in "last confirmed" costs nothing and saves a write per scroll.
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

const SOURCES = new Set(['facebook', 'craigslist', 'ebay']);

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Adapters send whatever their site exposes; everything collapses to one shape
// here so nothing downstream needs to know the origin.
// A condition is a short phrase. Extensions running the Craigslist adapter
// from before its fix send the next attribute along with it ("good\nmake"),
// so only the first line is kept — which also repairs such listings the next
// time they're captured.
function firstLine(text) {
  const line = String(text ?? '').split(/[\n|]/)[0].trim();
  return line || null;
}

export function normalize(raw, origin) {
  if (!SOURCES.has(raw.source)) return { error: `unknown source: ${raw.source}` };
  if (!raw.source_id) return { error: 'missing source_id' };
  if (!raw.title) return { error: 'missing title' };

  const price = num(raw.price);
  const mode = raw.acquisition_mode === 'shipped' ? 'shipped' : 'pickup';

  // Craigslist detail pages expose real coordinates; Facebook never does, so a
  // city centroid stands in. Without this, every FB listing had no distance and
  // therefore no pickup cost, quietly overstating its profit.
  let lat = num(raw.lat);
  let lon = num(raw.lon);
  let geoSource = lat != null && lon != null ? 'exact' : null;

  if (geoSource == null && raw.location_name) {
    const city = coordsForCity(raw.location_name);
    if (city) {
      lat = city.lat;
      lon = city.lon;
      geoSource = 'city';
    }
  }

  const distance =
    mode === 'shipped' ? null : haversineMi(origin.lat, origin.lon, lat, lon);

  return {
    id: `${raw.source}:${raw.source_id}`,
    source: raw.source,
    source_id: String(raw.source_id),
    url: raw.url ?? null,
    title: String(raw.title).slice(0, 400),
    description: raw.description ? String(raw.description).slice(0, 4000) : null,
    raw_text: raw.raw_text ? String(raw.raw_text).slice(0, 8000) : null,
    price,
    currency: raw.currency || 'USD',
    acquisition_mode: mode,
    inbound_ship: num(raw.inbound_ship) ?? 0,
    lat,
    lon,
    geo_source: geoSource,
    location_name: raw.location_name ?? null,
    distance_mi: distance,
    category: categorize(raw.title, raw.description, raw.category).category,
    condition_raw: firstLine(raw.condition_raw),
    thumb_url: raw.thumb_url ?? null,
    images: raw.images ? JSON.stringify(raw.images) : null,
    posted_at: num(raw.posted_at),
  };
}

export async function ingestBatch(db, items, origin = HOME, capturedBy = null) {
  const now = Date.now();
  const accepted = [];
  const rejected = [];

  for (const raw of items) {
    const n = normalize(raw, origin);
    if (n.error) {
      rejected.push({ source_id: raw?.source_id ?? null, error: n.error });
      continue;
    }
    accepted.push(n);
  }

  if (!accepted.length) return { received: items.length, accepted: 0, rejected, results: [] };

  // Read what's already stored so we can record genuine changes rather than
  // rewriting every row on every re-capture, and judge condition from
  // everything known about a listing, not just what this capture carried.
  const ids = accepted.map((n) => n.id);
  const existing = await allIn(
    db,
    (ph) => `SELECT id, price, title, description, condition_raw FROM listings WHERE id IN (${ph})`,
    ids
  );
  const priorPrice = new Map(existing.map((r) => [r.id, r.price]));

  // The price range is judged on what the listing's price will be once this
  // batch is stored: the last price this batch carries for it, or failing that
  // the stored one. So a detail page that arrives without a price still
  // upgrades a listing already stored with one, rather than being refused.
  const batchPrice = new Map();
  for (const n of accepted) if (n.price != null) batchPrice.set(n.id, n.price);

  const inRange = [];
  for (const n of accepted) {
    const price = batchPrice.get(n.id) ?? priorPrice.get(n.id) ?? null;
    const reason =
      price == null
        ? 'no price'
        : price < CAPTURE_PRICE.min
          ? `price under $${CAPTURE_PRICE.min}`
          : price > CAPTURE_PRICE.max
            ? `price over $${CAPTURE_PRICE.max}`
            : null;
    if (reason) rejected.push({ source_id: n.source_id, error: reason });
    else inRange.push(n);
  }
  accepted.length = 0;
  accepted.push(...inRange);
  if (!accepted.length) return { received: items.length, accepted: 0, rejected, results: [] };

  // Condition inputs merged the way the listing upsert merges them: a capture's
  // value wins, a missing one keeps what's stored. A grid card carries no
  // description, and assessing it alone used to overwrite a detail page's
  // "like new" with "unknown" — confidence 0.2, enough to drop a listing below
  // the ranking gate.
  const known = new Map(existing.map((r) => [r.id, r]));

  // One listing can arrive twice in a batch (grid card plus detail page), so
  // collapse to the last known price per id before deciding what changed.
  const finalPrice = new Map();
  for (const n of accepted) if (n.price != null) finalPrice.set(n.id, n.price);

  const historyWritten = new Set();
  const stmts = [];
  for (const n of accepted) {
    if (!historyWritten.has(n.id) && finalPrice.has(n.id)) {
      const price = finalPrice.get(n.id);
      const isNew = !priorPrice.has(n.id);
      if (isNew || priorPrice.get(n.id) !== price) {
        historyWritten.add(n.id);
        stmts.push(
          db
            .prepare('INSERT INTO price_history (listing_id, price, observed_at) VALUES (?,?,?)')
            .bind(n.id, price, now)
        );
      }
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO listings (
             id, source, source_id, url, title, description, raw_text, price, currency,
             acquisition_mode, inbound_ship, lat, lon, geo_source, location_name, distance_mi,
             category, condition_raw, thumb_url, images, posted_at,
             first_seen, last_seen, status, captured_by, score_due_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)
           ON CONFLICT (id) DO UPDATE SET
             price = COALESCE(excluded.price, listings.price),
             description = COALESCE(excluded.description, listings.description),
             raw_text = COALESCE(excluded.raw_text, listings.raw_text),
             thumb_url = COALESCE(excluded.thumb_url, listings.thumb_url),
             images = COALESCE(excluded.images, listings.images),
             url = COALESCE(excluded.url, listings.url),
             condition_raw = COALESCE(excluded.condition_raw, listings.condition_raw),
             posted_at = COALESCE(excluded.posted_at, listings.posted_at),
             category = COALESCE(excluded.category, listings.category),
             location_name = COALESCE(excluded.location_name, listings.location_name),
             -- Coordinate precedence: real coordinates from a detail page beat a
             -- city centroid, a centroid beats nothing, and a later grid card
             -- carrying nulls never erases what we already have.
             lat = CASE
                     WHEN excluded.geo_source = 'exact' THEN excluded.lat
                     WHEN listings.geo_source = 'exact' THEN listings.lat
                     ELSE COALESCE(excluded.lat, listings.lat) END,
             lon = CASE
                     WHEN excluded.geo_source = 'exact' THEN excluded.lon
                     WHEN listings.geo_source = 'exact' THEN listings.lon
                     ELSE COALESCE(excluded.lon, listings.lon) END,
             distance_mi = CASE
                     WHEN excluded.geo_source = 'exact' THEN excluded.distance_mi
                     WHEN listings.geo_source = 'exact' THEN listings.distance_mi
                     ELSE COALESCE(excluded.distance_mi, listings.distance_mi) END,
             geo_source = CASE
                     WHEN excluded.geo_source = 'exact' THEN 'exact'
                     WHEN listings.geo_source = 'exact' THEN 'exact'
                     ELSE COALESCE(excluded.geo_source, listings.geo_source) END,
             last_seen = excluded.last_seen,
             -- First capture keeps the credit; a later re-capture by the other
             -- person doesn't reassign who found it.
             captured_by = COALESCE(listings.captured_by, excluded.captured_by),
             -- New listings join the scoring queue at insert. A listing swept as
             -- gone and seen again rejoins it; anything else keeps its place.
             score_due_at = CASE WHEN listings.status = 'gone' THEN excluded.score_due_at
                                 ELSE listings.score_due_at END,
             score_attempts = CASE WHEN listings.status = 'gone' THEN 0 ELSE listings.score_attempts END,
             status = 'active'
           -- Browsing past a listing you already have rewrote its row every
           -- time, and D1 counts an identical rewrite as written rows plus one
           -- per index touched. Now it writes only when something would change,
           -- or to refresh last_seen at most hourly: freshness is judged in days.
           WHERE listings.status = 'gone'
              OR excluded.last_seen - listings.last_seen >= ${LAST_SEEN_REFRESH_MS}
              OR (excluded.price IS NOT NULL AND excluded.price IS NOT listings.price)
              OR (excluded.description IS NOT NULL AND excluded.description IS NOT listings.description)
              OR (excluded.raw_text IS NOT NULL AND excluded.raw_text IS NOT listings.raw_text)
              OR (excluded.thumb_url IS NOT NULL AND excluded.thumb_url IS NOT listings.thumb_url)
              OR (excluded.images IS NOT NULL AND excluded.images IS NOT listings.images)
              OR (excluded.url IS NOT NULL AND excluded.url IS NOT listings.url)
              OR (excluded.condition_raw IS NOT NULL AND excluded.condition_raw IS NOT listings.condition_raw)
              OR (excluded.posted_at IS NOT NULL AND excluded.posted_at IS NOT listings.posted_at)
              OR (excluded.category IS NOT NULL AND excluded.category IS NOT listings.category)
              OR (excluded.location_name IS NOT NULL AND excluded.location_name IS NOT listings.location_name)
              OR ((excluded.geo_source = 'exact' OR listings.geo_source IS NOT 'exact')
                  AND ((excluded.lat IS NOT NULL AND excluded.lat IS NOT listings.lat)
                    OR (excluded.lon IS NOT NULL AND excluded.lon IS NOT listings.lon)
                    OR (excluded.distance_mi IS NOT NULL AND excluded.distance_mi IS NOT listings.distance_mi)
                    OR (excluded.geo_source IS NOT NULL AND excluded.geo_source IS NOT listings.geo_source)))
              OR (listings.captured_by IS NULL AND excluded.captured_by IS NOT NULL)`
        )
        .bind(
          n.id, n.source, n.source_id, n.url, n.title, n.description, n.raw_text,
          n.price, n.currency, n.acquisition_mode, n.inbound_ship, n.lat, n.lon,
          n.geo_source, n.location_name, n.distance_mi, n.category, n.condition_raw,
          n.thumb_url, n.images, n.posted_at, now, now, capturedBy, now
        )
    );

    const prior = known.get(n.id);
    const merged = {
      title: prior?.title ?? n.title,
      description: n.description ?? prior?.description ?? null,
      condition_raw: n.condition_raw ?? prior?.condition_raw ?? null,
    };
    known.set(n.id, merged);

    const c = assessCondition(merged);
    stmts.push(
      db
        .prepare(
          // Unchanged assessments are skipped: D1 bills an identical rewrite the
          // same as a real one, row and index alike.
          `INSERT INTO conditions (listing_id, band, multiplier, confidence, signals, assessed_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT (listing_id) DO UPDATE SET
             band = excluded.band, multiplier = excluded.multiplier,
             confidence = excluded.confidence, signals = excluded.signals,
             assessed_at = excluded.assessed_at
           WHERE conditions.band IS NOT excluded.band
              OR conditions.multiplier IS NOT excluded.multiplier
              OR conditions.confidence IS NOT excluded.confidence
              OR conditions.signals IS NOT excluded.signals`
        )
        .bind(n.id, c.band, c.multiplier, c.confidence, JSON.stringify(c.signals), now)
    );
  }

  await db.batch(stmts);

  // Scores are returned per listing so the extension can annotate cards in-page
  // later without changing this contract. Null until matching and comps land.
  const scored = await allIn(
    db,
    (ph) => `SELECT listing_id, score, profit, roi, confidence FROM scores WHERE listing_id IN (${ph})`,
    ids
  );
  const scoreById = new Map(scored.map((r) => [r.listing_id, r]));

  return {
    received: items.length,
    accepted: accepted.length,
    rejected,
    results: accepted.map((n) => ({
      id: n.id,
      ...(scoreById.get(n.id) ?? { score: null, profit: null, roi: null, confidence: null }),
    })),
  };
}
