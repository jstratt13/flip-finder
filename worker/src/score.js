import {
  VENUES, BULKY_VENUES, SCORING, ACTIVE_TO_REALIZED, LOCAL_ASK_TO_REALIZED,
  RETAIL_ANCHOR_WEIGHT, ACTIVE_ANCHOR_WEIGHT,
  shippingFor, pickupCost, confidenceFor, isBulky,
} from './config.js';

// Blend the two anchors we can get for free. Marketplace Insights (real sold
// comps) would replace this wholesale if access ever comes through.
function anchorValue(comp) {
  if (!comp) return null;
  const retail = comp.retail_price ?? null;

  // Local comps are already local asking prices, so they take the haggle
  // discount here and the venue applies no further one. Discounting in both
  // places would charge the same gap twice.
  const discount = comp.source === 'local' ? LOCAL_ASK_TO_REALIZED : ACTIVE_TO_REALIZED;
  const active = comp.active_median != null ? comp.active_median * discount : null;

  if (comp.source === 'local') {
    return active != null ? { value: active, source: 'local' } : null;
  }

  if (retail != null && active != null) {
    return {
      value: retail * RETAIL_ANCHOR_WEIGHT + active * ACTIVE_ANCHOR_WEIGHT,
      source: 'blended',
    };
  }
  if (active != null) return { value: active, source: 'active' };
  if (retail != null) return { value: retail, source: 'retail' };
  return null;
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
  const anchor = anchorValue(comp);
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

  const grossBase = anchor.value * (condition?.multiplier ?? 0.65);

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

export function passesGates(s) {
  return (
    s.score != null &&
    s.profit >= SCORING.min_profit &&
    s.confidence >= SCORING.min_confidence &&
    s.roi >= SCORING.min_roi
  );
}
