export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// Marketplace prices carry joke listings and accessory listings that share the
// same search terms, so trim both tails before taking the median.
export function summarize(prices) {
  const sorted = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (!sorted.length) return { median: null, p25: null, p75: null, n: 0 };

  const lo = percentile(sorted, 0.1);
  const hi = percentile(sorted, 0.9);
  const trimmed = sorted.filter((p) => p >= lo && p <= hi);
  const use = trimmed.length >= 3 ? trimmed : sorted;

  return {
    median: percentile(use, 0.5),
    p25: percentile(use, 0.25),
    p75: percentile(use, 0.75),
    n: sorted.length,
  };
}
