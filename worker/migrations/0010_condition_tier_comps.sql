-- 0010 — the spread of the new/like-new side, so a like-new local listing is
-- priced against comps of its own condition.
--
-- comps already carried retail_price and n_new for that side, but no p25/p75:
-- confidence v2 reads the spread of whichever side sets the value, and it was
-- always handed the used side's. With the side now chosen by the listing's
-- condition band, the wrong spread would mean a confidence number about a
-- distribution the value didn't come from.

ALTER TABLE comps ADD COLUMN new_p25 REAL;
ALTER TABLE comps ADD COLUMN new_p75 REAL;
