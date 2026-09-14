import { HOME, haversineMi } from './config.js';
import { assessCondition } from './condition.js';
import { categorize } from './categorize.js';
import { coordsForCity } from './cities.js';
import { allIn } from './d1.js';

const SOURCES = new Set(['facebook', 'craigslist', 'ebay']);

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Adapters send whatever their site exposes; everything collapses to one shape
// here so nothing downstream needs to know the origin.
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
    condition_raw: raw.condition_raw ?? null,
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

  // Read current prices first so we can record genuine changes rather than
  // rewriting every row on every re-capture.
  const ids = accepted.map((n) => n.id);
  const existing = await allIn(db, (ph) => `SELECT id, price FROM listings WHERE id IN (${ph})`, ids);
  const priorPrice = new Map(existing.map((r) => [r.id, r.price]));

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
             first_seen, last_seen, status, captured_by
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)
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
             status = 'active'`
        )
        .bind(
          n.id, n.source, n.source_id, n.url, n.title, n.description, n.raw_text,
          n.price, n.currency, n.acquisition_mode, n.inbound_ship, n.lat, n.lon,
          n.geo_source, n.location_name, n.distance_mi, n.category, n.condition_raw,
          n.thumb_url, n.images, n.posted_at, now, now, capturedBy
        )
    );

    const c = assessCondition(n);
    stmts.push(
      db
        .prepare(
          `INSERT INTO conditions (listing_id, band, multiplier, confidence, signals, assessed_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT (listing_id) DO UPDATE SET
             band = excluded.band, multiplier = excluded.multiplier,
             confidence = excluded.confidence, signals = excluded.signals,
             assessed_at = excluded.assessed_at`
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
