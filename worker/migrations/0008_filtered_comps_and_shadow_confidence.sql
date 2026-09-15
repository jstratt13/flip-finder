-- 0008 — eBay comps filtered to the listing's identity, and valuation
-- confidence (v2) computed in shadow.
--
-- comps: how many results eBay returned and how many were judged to be the
-- product (identity.js). filtered = 1 once comps come from the relevance-
-- filtered pipeline; older rows were built from everything eBay returned.
--
-- scores: the v2 confidence model (valuation-confidence.js) stored beside the
-- original. Nothing reads these for ranking or gates yet — they exist so v2
-- can be watched on live data and checked against Jordan's valuation labels
-- before it replaces the original.

ALTER TABLE comps ADD COLUMN n_results INTEGER;
ALTER TABLE comps ADD COLUMN n_relevant INTEGER;
ALTER TABLE comps ADD COLUMN filtered INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scores ADD COLUMN confidence_v2 REAL;
ALTER TABLE scores ADD COLUMN p_right REAL;
ALTER TABLE scores ADD COLUMN p_within REAL;
ALTER TABLE scores ADD COLUMN expected_profit REAL;
