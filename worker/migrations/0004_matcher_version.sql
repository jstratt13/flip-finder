-- 0004 — which matcher produced each listing's product key.
--
-- Listings are only matched once, when first scored, so a fix to the matcher
-- never reached anything already captured. Recording the version lets resolve
-- find matches made by older logic and redo them. Existing rows are version 1.

ALTER TABLE listing_matches ADD COLUMN matcher_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_matches_version ON listing_matches (matcher_version);
