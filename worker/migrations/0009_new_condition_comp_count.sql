-- 0009 — how many NEW-condition resale listings a product's comps came from.
--
-- comps.retail_price was always the median of eBay's new-condition listings.
-- Those are resale listings like any other (a private seller with a sealed box),
-- so they stay — but they price a NEW or LIKE-NEW local item, never a used one.
-- Deciding that needs their count, which was never stored: n_active counted only
-- the used side.
--
-- Backfill is deliberately absent: rows written before this have no count, which
-- reads as "not enough" and falls back to the used side until the next fetch.

ALTER TABLE comps ADD COLUMN n_new INTEGER;
