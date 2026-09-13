-- 0001 — initial schema.
--
-- Migrations are the source of truth for the database from here on. Wrangler
-- tracks which have run, so never edit an applied migration: change it and a
-- fresh database and a live one silently diverge. Add a new numbered file.

-- Both people capture and both see everything. Separate ingest keys exist so
-- either can be revoked without locking out the other, and so captures can be
-- attributed.
CREATE TABLE IF NOT EXISTS contributors (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  salt              TEXT NOT NULL,
  ingest_key        TEXT NOT NULL UNIQUE,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contributors_key ON contributors (ingest_key, active);

-- Normalized listing, identical shape regardless of source.
CREATE TABLE IF NOT EXISTS listings (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  url               TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  raw_text          TEXT,
  price             REAL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  acquisition_mode  TEXT NOT NULL DEFAULT 'pickup',
  inbound_ship      REAL NOT NULL DEFAULT 0,
  lat               REAL,
  lon               REAL,
  -- 'exact' when the source gave coordinates, 'city' when they were derived
  -- from a city name. Distances from a centroid are approximate.
  geo_source        TEXT,
  location_name     TEXT,
  distance_mi       REAL,
  category          TEXT,
  condition_raw     TEXT,
  thumb_url         TEXT,
  images            TEXT,
  posted_at         INTEGER,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  captured_by       INTEGER,
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_source ON listings (source, status);
CREATE INDEX IF NOT EXISTS idx_listings_seen ON listings (last_seen DESC);

-- One row per observed price change. A listing that sits and drops is a
-- motivated seller, which is a ranking signal in its own right.
CREATE TABLE IF NOT EXISTS price_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id        TEXT NOT NULL,
  price             REAL NOT NULL,
  observed_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_history ON price_history (listing_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS products (
  product_key       TEXT PRIMARY KEY,
  brand             TEXT,
  model             TEXT,
  category          TEXT,
  canonical_title   TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listing_matches (
  listing_id        TEXT PRIMARY KEY,
  product_key       TEXT NOT NULL,
  match_score       REAL NOT NULL,
  method            TEXT NOT NULL,
  matched_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_product ON listing_matches (product_key);

-- Valuation anchors, cached per product rather than per listing.
CREATE TABLE IF NOT EXISTS comps (
  product_key       TEXT PRIMARY KEY,
  retail_price      REAL,
  active_median     REAL,
  active_p25        REAL,
  active_p75        REAL,
  n_active          INTEGER NOT NULL DEFAULT 0,
  source            TEXT,
  fetched_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conditions (
  listing_id        TEXT PRIMARY KEY,
  band              TEXT NOT NULL,
  multiplier        REAL NOT NULL,
  confidence        REAL NOT NULL,
  signals           TEXT,
  assessed_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  listing_id        TEXT PRIMARY KEY,
  anchor_value      REAL,
  anchor_source     TEXT,
  est_net_fb        REAL,
  est_net_ebay      REAL,
  est_net_blended   REAL,
  acquisition_cost  REAL,
  profit            REAL,
  roi               REAL,
  confidence        REAL,
  score             REAL,
  computed_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores (score DESC);

-- Outcome tracking. est_snapshot is frozen at purchase time and never rewritten:
-- calibration must compare against what the model predicted then, not a later value.
CREATE TABLE IF NOT EXISTS acquisitions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id        TEXT NOT NULL,
  acquired_at       INTEGER NOT NULL,
  price_paid        REAL NOT NULL,
  pickup_cost       REAL NOT NULL DEFAULT 0,
  est_snapshot      TEXT NOT NULL,
  acquired_by       INTEGER,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_acq_listing ON acquisitions (listing_id);

CREATE TABLE IF NOT EXISTS sales (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  acquisition_id    INTEGER NOT NULL,
  sold_at           INTEGER NOT NULL,
  venue             TEXT NOT NULL,
  sale_price        REAL NOT NULL,
  fees_paid         REAL NOT NULL DEFAULT 0,
  shipping_paid     REAL NOT NULL DEFAULT 0,
  sold_by           INTEGER,
  notes             TEXT,
  FOREIGN KEY (acquisition_id) REFERENCES acquisitions (id)
);

CREATE INDEX IF NOT EXISTS idx_sales_acq ON sales (acquisition_id);
