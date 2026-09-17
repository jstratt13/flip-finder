-- 0011 — every listing browsed, kept as market data rather than as a candidate.
--
-- Ingest refuses most of what is captured: no stated condition, sold for parts,
-- outside the $5–$1,000 range, whole vehicles. Those are rules about what Jordan
-- would buy, not about what the local market is asking, and until now a refused
-- capture was counted and dropped. That threw away the only comp source that
-- costs no eBay call: what similar things ask for locally.
--
-- Rows here are never scored, never priced against eBay, and never shown on
-- Opportunities or Captured. localcomps reads them so a bulky item is priced
-- against everything ever browsed, not just what survived the gates.
--
-- refused_reason is NULL for captures that also became listings, so the table
-- is the full picture of the local market rather than only its rejects.

CREATE TABLE IF NOT EXISTS market_observations (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  title             TEXT NOT NULL,
  price             REAL,
  condition_band    TEXT,
  category          TEXT,
  product_key       TEXT,
  matcher_version   INTEGER,
  location_name     TEXT,
  refused_reason    TEXT,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL
);

-- The one read path: asks for a product, recent first.
CREATE INDEX IF NOT EXISTS idx_observations_product
  ON market_observations (product_key, last_seen DESC);
