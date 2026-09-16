import {
  VENUES, BULKY_VENUES, SCORING, ACTIVE_TO_REALIZED, LOCAL_ASK_TO_REALIZED,
  MIN_RESALE_COMPS,
  shippingFor, pickupCost, confidenceFor, isBulky,
} from './config.js';

// What the item resells for, from resale listings of the same condition.
//
// Marketplace Insights (real sold comps) would replace active asks wholesale if
// access ever comes through. Until then: the median asking price on the matching
// side, less the gap between asking and realized.
//
// eBay's new-condition listings are resale listings and are kept — they price a
// new or like-new local item. They are never blended into a used one's value,
// which is what ran valuations 2.3x high. See MIN_RESALE_COMPS in config.js.
const NEW_BANDS = new Set(['new', 'like_new']);

function anchorValue(comp, condition) {
  if (!comp) return null;

  // Local comps are already local asking prices, so they take the haggle
  // discount here and the venue applies no further one. Discounting in both
  // places would charge the same gap twice. Their floor is MIN_LOCAL_COMPS,
  // applied where the pool is built.
  if (comp.source === 'local') {
    return comp.active_median != null
      ? { value: comp.active_median * LOCAL_ASK_TO_REALIZED, source: 'local' }
      : null;
  }

  const side =
    NEW_BANDS.has(condition?.band) && (comp.n_new ?? 0) >= MIN_RESALE_COMPS
      ? { median: comp.retail_price, n: comp.n_new ?? 0, source: 'retail' }
      : { median: comp.active_median, n: comp.n_active ?? 0, source: 'active' };

  // Too few resale listings to call it a market: decline to guess rather than
  // publish a number built on one seller's asking price.
  if (side.median == null || side.n < MIN_RESALE_COMPS) return null;

  return { value: side.median * ACTIVE_TO_REALIZED, source: side.source };
}

function netForVenue(grossBase, venue) {
  const gross = grossBase * venue.price_factor;
  const fees = gross * venue.fee_rate + venue.flat_fee;
  const ship = venue.ships ? shippingFor(gross) : 0;
  return gross - fees - ship;
}

// Without sold-comp data there is no real sell-through signal. Neutral until
// outcome tracking supplies days-to-sell per category.
function liquidityFor() {
  return 1.0;
}

export function scoreListing({ listing, comp, condition, match }) {
  const anchor = anchorValue(comp, condition);
  const now = Date.now();

  const base = {
    listing_id: listing.id,
    anchor_value: anchor?.value ?? null,
    anchor_source: anchor?.source ?? null,
    est_net_fb: null,
    est_net_ebay: null,
    est_net_blended: null,
    acquisition_cost: null,
    profit: null,
    roi: null,
    confidence: 0,
    score: null,
    computed_at: now,
  };

  if (!anchor || listing.price == null) return base;

  // Every band except fair multiplies by 1.0: the comps are already the item's
  // own condition, so discounting again would charge it twice. See
  // CONDITION_BANDS for why fair is the exception and parts is unreachable.
  const grossBase = anchor.value * (condition?.multiplier ?? 1.0);

  // A sofa is not going on eBay. Pricing one with a 33% eBay share and $25 of
  // freight overstates the net by more than the entire margin.
  const bulky = isBulky(listing.title ?? '', listing.category ?? '');
  const venues = bulky ? BULKY_VENUES : VENUES;

  let netBlended = 0;
  const nets = {};
  for (const [name, v] of Object.entries(venues)) {
    nets[name] = netForVenue(grossBase, v);
    netBlended += nets[name] * v.share;
  }

  const netFb = nets.facebook ?? null;
  const netEbay = nets.ebay ?? null;

  // Shipped items carry inbound freight instead of a drive; they are exempt
  // from the distance filter entirely.
  const acqExtra =
    listing.acquisition_mode === 'shipped'
      ? listing.inbound_ship ?? 0
      : pickupCost(listing.distance_mi);

  const acquisitionCost = listing.price + acqExtra;
  const profit = netBlended - acquisitionCost;
  const roi = acquisitionCost > 0 ? profit / acquisitionCost : 0;

  const confidence = confidenceFor({
    matchScore: match?.match_score,
    nComps: comp.n_active,
    conditionConfidence: condition?.confidence,
  });

  const liquidity = liquidityFor(listing.category);

  let score = null;
  if (profit > 0 && confidence > 0) {
    score =
      profit *
      Math.pow(Math.max(roi, 0), SCORING.alpha) *
      Math.pow(confidence, SCORING.beta) *
      Math.pow(liquidity, SCORING.gamma);
  }

  return {
    ...base,
    est_net_fb: netFb,
    est_net_ebay: netEbay,
    est_net_blended: netBlended,
    acquisition_cost: acquisitionCost,
    profit,
    roi,
    confidence,
    score,
  };
}

// What reaches Opportunities, as one predicate. Production enforces the same
// gates in SQL (index.js), because the ranking is a query; this is what that
// query means, and what the tests check.
//
// Confidence is v2 — P(right product) x P(within 25% | right product). It is
// computed in resolve.js, beside the score rather than inside it, so callers
// pass the stored row: a listing with no v2 number has not been judged on that
// scale and does not rank.
export function passesGates(s) {
  return (
    s.score != null &&
    s.profit >= SCORING.min_profit &&
    s.confidence_v2 != null &&
    s.confidence_v2 >= SCORING.min_confidence_v2 &&
    s.roi >= SCORING.min_roi
  );
}
