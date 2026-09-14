-- 0005 — an indexed scoring queue with backoff.
--
-- The cron found work by joining every listing to its score and filtering,
-- which reads the whole table on every run, and it retried anything unpriced
-- every 6 hours forever. Each retry rewrites the listing's rows, so a large
-- unpriceable backlog could approach D1's 100,000 rows-written daily limit.
--
-- score_due_at is when a listing next needs scoring (NULL once it has a score);
-- score_attempts counts real pricing attempts that produced nothing, and sets
-- how far the next one is pushed out.

ALTER TABLE listings ADD COLUMN score_due_at INTEGER;
ALTER TABLE listings ADD COLUMN score_attempts INTEGER NOT NULL DEFAULT 0;

-- Never scored: due now.
UPDATE listings SET score_due_at = 0
WHERE status = 'active'
  AND id NOT IN (SELECT listing_id FROM scores);

-- Scored but unpriced: due when the old 6-hour retry window would have ended.
UPDATE listings
SET score_due_at = (SELECT s.computed_at FROM scores s WHERE s.listing_id = listings.id) + 21600000
WHERE status = 'active'
  AND id IN (SELECT listing_id FROM scores WHERE score IS NULL);

-- Partial: scored and gone listings aren't in it, so it stays the size of the
-- actual queue rather than the table.
CREATE INDEX IF NOT EXISTS idx_listings_due ON listings (score_due_at) WHERE score_due_at IS NOT NULL;
