-- 0006 — count recent eBay lookups without scanning comps.
--
-- Every cron run now checks how many eBay comps were fetched in the last 24
-- hours, to stay under eBay's daily call allowance. At one run every 5 minutes
-- a table scan here would read every cached product 288 times a day.

CREATE INDEX IF NOT EXISTS idx_comps_fetched ON comps (source, fetched_at);
