-- 0003 — manually saved listings.
--
-- A deliberate override of the ranking: anything saved here stays visible
-- regardless of score, comps, or gates. The model decides what's probably
-- worth looking at; this is where you disagree with it.
--
-- Shared rather than per-person, matching acquisitions — both of you see the
-- same board, and `added_by` records who flagged it. One row per listing, so
-- saving something the other person already saved is a no-op rather than a
-- duplicate.
CREATE TABLE IF NOT EXISTS watchlist (
  listing_id        TEXT PRIMARY KEY,
  added_by          INTEGER,
  added_at          INTEGER NOT NULL,
  note              TEXT
);

CREATE INDEX IF NOT EXISTS idx_watchlist_added ON watchlist (added_at DESC);
