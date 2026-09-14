-- 0007 — page the Captured tab by (last_seen, id) without scanning.
--
-- A capture batch shares one last_seen (production: 382 listings, 11 distinct
-- values, one shared by 100), so paging needs id as a tie-break. An index on
-- last_seen alone can't order by both: SQLite sorted in a temp b-tree and a
-- page 50 rows deep read 661 rows. On (last_seen, id) the page query seeks
-- straight to the cursor.
--
-- Replaces idx_listings_seen rather than adding to it: every query that used
-- it filters or orders on last_seen, which this index leads with, so writes
-- keep touching one index, not two.

DROP INDEX IF EXISTS idx_listings_seen;
CREATE INDEX IF NOT EXISTS idx_listings_seen_id ON listings (last_seen DESC, id DESC);
