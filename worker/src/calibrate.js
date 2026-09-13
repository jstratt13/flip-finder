import { VENUES, CONDITION_BANDS } from './config.js';

// Compares what the model predicted at purchase time against what actually
// happened, and reports the corrections the data supports.
//
// Nothing here changes a parameter. It reports; you decide. Auto-tuning on a
// handful of sales would chase noise, and the frozen estimate exists so the
// comparison is honest — not so the model can quietly rewrite itself.

const MIN_OVERALL = 8;
const MIN_PER_GROUP = 5;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

export function calibrate(rows) {
  // Only closed flips carry a realised outcome, and only ones acquired after
  // scoring have a prediction to compare against.
  const closed = rows.filter((r) => r.sale_id != null);
  const predicted = closed.filter((r) => r.predicted_profit != null);

  const profitErrors = predicted.map((r) => r.actual_profit - r.predicted_profit);

  // Realised net isolates the resale estimate from what you paid, which is the
  // part the model is actually guessing at.
  const withNet = predicted
    .map((r) => {
      const realised = r.sale_price - (r.fees_paid ?? 0) - (r.shipping_paid ?? 0);
      const expected = r.venue === 'ebay' ? r.est_net_ebay : r.est_net_fb;
      return expected && expected > 0 ? { ...r, realised, expected, ratio: realised / expected } : null;
    })
    .filter(Boolean);

  const venueGroups = groupBy(closed, (r) => r.venue);
  const venue_mix = [...venueGroups.entries()].map(([venue, rs]) => ({
    venue,
    sales: rs.length,
    measured_share: closed.length ? rs.length / closed.length : null,
    configured_share: VENUES[venue]?.share ?? null,
  }));

  const venue_accuracy = [...groupBy(withNet, (r) => r.venue).entries()].map(([venue, rs]) => {
    const ratio = median(rs.map((r) => r.ratio));
    const current = VENUES[venue]?.price_factor ?? null;
    return {
      venue,
      sales: rs.length,
      median_ratio: ratio,
      current_price_factor: current,
      // A ratio below 1 means the model expected more than the sale returned.
      suggested_price_factor:
        rs.length >= MIN_PER_GROUP && ratio != null && current != null
          ? Number((current * ratio).toFixed(3))
          : null,
    };
  });

  const by_condition = [...groupBy(withNet, (r) => r.condition_band).entries()].map(
    ([band, rs]) => {
      const ratio = median(rs.map((r) => r.ratio));
      const current = CONDITION_BANDS[band]?.multiplier ?? null;
      return {
        band,
        sales: rs.length,
        median_ratio: ratio,
        current_multiplier: current,
        suggested_multiplier:
          rs.length >= MIN_PER_GROUP && ratio != null && current != null
            ? Number((current * ratio).toFixed(3))
            : null,
      };
    }
  );

  const by_category = [...groupBy(predicted, (r) => r.category).entries()].map(([category, rs]) => ({
    category,
    sales: rs.length,
    median_profit_error: median(rs.map((r) => r.actual_profit - r.predicted_profit)),
  }));

  const medianError = median(profitErrors);

  return {
    sales_recorded: closed.length,
    sales_with_prediction: predicted.length,
    ready: predicted.length >= MIN_OVERALL,
    min_sales_for_suggestions: MIN_OVERALL,

    accuracy: {
      median_profit_error: medianError,
      mean_profit_error: profitErrors.length
        ? profitErrors.reduce((a, b) => a + b, 0) / profitErrors.length
        : null,
      // Which way the model is systematically wrong is more useful than the
      // size of the error, because it says which parameter to move.
      bias:
        medianError == null
          ? null
          : medianError < -2
            ? 'optimistic'
            : medianError > 2
              ? 'conservative'
              : 'balanced',
      within_25pct: predicted.length
        ? predicted.filter(
            (r) =>
              r.predicted_profit !== 0 &&
              Math.abs((r.actual_profit - r.predicted_profit) / Math.abs(r.predicted_profit)) <= 0.25
          ).length / predicted.length
        : null,
    },

    venue_mix,
    venue_accuracy,
    by_condition,
    by_category,
  };
}
