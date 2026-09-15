// Valuation confidence (v2). Runs in shadow in production: computed and stored
// beside the original confidence, not yet used for ranking or gates.
//
// Confidence = P(our resale estimate is within X% of what the item would
// really sell for), X = 25% (Jordan, 2026-09-15). It factors into:
//
//   P(right product)           — are the comparables even this product?
// × P(within X% | right product) — given they are, how tight is the estimate?
//
// The second factor treats the true value as log-normal around our estimate.
// Every source of doubt is a named spread (log standard deviation) added in
// quadrature, so each assumption can be argued with, measured, and replaced.
// Starting numbers are guesses unless the comment says where they came from.

export const WITHIN = 0.25;

// P(the comparables are this product), by what the title pins down. From the
// held-out relevance check (research/03-holdout-score.mjs): code/generation
// listings matched eBay results with 100% precision, brand-only with 50%.
export const IDENTITY_PRIOR = {
  'brand+code': 0.9,
  code: 0.8,
  'brand+noun': 0.4,
  brand: 0.35,
  noun: 0.15,
  none: 0.05,
  local: 0.55, // bulky goods priced by type from local asks ("oak dresser")
};

// Unknown condition is a spread of possibilities, not a penalty. Shares are a
// guess at used-marketplace listings; outcome data should replace them.
export const CONDITION_PRIOR = { new: 0.05, like_new: 0.25, good: 0.45, fair: 0.18, parts: 0.07 };
export const CONDITION_MULTIPLIER = { new: 1.0, like_new: 0.88, good: 0.75, fair: 0.55, parts: 0.3 };

export const SPREAD = {
  // Used asking prices for one product when too few comps to measure. From the
  // eBay sample: median half-IQR of relevant results was 16%, of all 29%.
  default_item: 0.3,
  // How many comparables the typical spread counts as: a sample of 8 is trusted
  // half and half, 24 is trusted three to one.
  spread_prior_weight: 8,
  // Once condition is read, less of the comp spread applies to this item.
  known_condition_factor: 0.6,
  min_item: 0.08,
  // Asking → realized: ACTIVE_TO_REALIZED is 0.8 with no data behind it.
  realized_ebay: 0.12,
  // LOCAL_ASK_TO_REALIZED is the least-founded number in the model.
  realized_local: 0.2,
  // New cheaper than used: rarely true of one product, usually mixed results.
  inverted: 0.25,
  // Comparables not yet filtered to the listing's identity: extra doubt that
  // shrinks as the purity of what eBay returned rises.
  unfiltered_at_zero_purity: 0.45,
};

// Normal CDF (Abramowitz–Stegun 7.1.26), accurate to ~1e-7.
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function conditionSpread(band) {
  if (band && band !== 'unknown' && CONDITION_MULTIPLIER[band] != null) {
    return { mean: CONDITION_MULTIPLIER[band], logSd: 0 };
  }
  let mean = 0;
  for (const [b, p] of Object.entries(CONDITION_PRIOR)) mean += p * CONDITION_MULTIPLIER[b];
  let v = 0;
  for (const [b, p] of Object.entries(CONDITION_PRIOR)) v += p * Math.log(CONDITION_MULTIPLIER[b] / mean) ** 2;
  return { mean, logSd: Math.sqrt(v) };
}

// comps: { n, p25, p75, median, newMedian, source: 'ebay'|'local', filtered: bool, purity }
export function confidence({ strength, comps, band }) {
  const parts = {};
  const pRight = IDENTITY_PRIOR[comps?.source === 'local' ? 'local' : strength] ?? 0.05;

  if (!comps || !(comps.median > 0)) return { confidence: 0, pRight, pWithin: 0, sigma: null, parts };

  // A spread measured from a handful of prices is itself a guess: three comps
  // at $30, $30 and $40 look tight until a fourth at $76 arrives (Sangean WFR-20,
  // second eBay sample). So the measured spread is shrunk toward the typical one,
  // weighted by how many prices back it — it only earns full trust at scale.
  const measured = comps.n >= 3 && comps.p25 > 0 && comps.p75 > comps.p25;
  const observedSd = measured ? Math.log(comps.p75 / comps.p25) / 1.349 : SPREAD.default_item;
  const w = measured ? comps.n / (comps.n + SPREAD.spread_prior_weight) : 0;
  const itemSd = Math.sqrt(w * observedSd ** 2 + (1 - w) * SPREAD.default_item ** 2);
  const cond = conditionSpread(band);
  const known = band && band !== 'unknown';

  // The comp spread already spans the conditions used listings come in, so an
  // unread condition is covered by it; a read condition narrows it. Adding the
  // condition prior's own spread on top would count the same doubt twice.
  parts.item = Math.max(SPREAD.min_item, itemSd * (known ? SPREAD.known_condition_factor : 1));
  parts.median = (1.2533 * (measured ? itemSd : SPREAD.default_item)) / Math.sqrt(Math.max(1, comps.n));
  parts.realized = comps.source === 'local' ? SPREAD.realized_local : SPREAD.realized_ebay;
  parts.inverted = comps.newMedian != null && comps.newMedian < comps.median ? SPREAD.inverted : 0;
  parts.unfiltered = comps.filtered ? 0 : SPREAD.unfiltered_at_zero_purity * (1 - (comps.purity ?? 0));

  const sigma = Math.sqrt(Object.values(parts).reduce((s, x) => s + x * x, 0));
  const pWithin = phi(Math.log(1 + WITHIN) / sigma) - phi(Math.log(1 - WITHIN) / sigma);
  return { confidence: pRight * pWithin, pRight, pWithin, sigma, parts, conditionMean: cond.mean };
}
