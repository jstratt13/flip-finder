// Every number here is a starting guess. Outcome tracking calibrates them
// against recorded sales — see calibrate.js.

export const HOME = { zip: '92649', lat: 33.7172, lon: -118.0453 };

export const CONDITION_BANDS = {
  new: { multiplier: 1.0 },
  like_new: { multiplier: 0.88 },
  good: { multiplier: 0.75 },
  fair: { multiplier: 0.55 },
  parts: { multiplier: 0.3 },
  unknown: { multiplier: 0.65 },
};

// Things that realistically cannot be shipped for a sane price. Selling these
// means a local cash sale, so modelling an eBay share with $25 freight on a
// sofa overstates the net by more than the whole margin.
export const BULKY_TERMS = [
  'couch', 'sofa', 'sectional', 'loveseat', 'recliner', 'futon', 'ottoman', 'armchair',
  'dresser', 'nightstand', 'armoire', 'wardrobe', 'credenza', 'hutch', 'buffet',
  'bookcase', 'bookshelf', 'shelving', 'cabinet', 'vanity', 'chaise', 'chair',
  'table', 'desk', 'bed', 'bedframe', 'headboard', 'mattress', 'boxspring', 'futon',
  'barstool', 'bench', 'sideboard', 'dining',
  'fridge', 'refrigerator', 'freezer', 'washer', 'dryer', 'dishwasher', 'stove',
  'oven', 'range', 'treadmill', 'elliptical', 'squat', 'piano', 'organ',
  'hot tub', 'patio', 'grill', 'mower', 'generator', 'safe', 'kayak', 'canoe',
  'surfboard', 'paddleboard', 'rug', 'mirror', 'playset', 'trampoline', 'shed',
];

const BULKY_RE = new RegExp(`\\b(${BULKY_TERMS.join('|')})s?\\b`, 'i');

// Large TVs are technically shippable and practically never are.
const BULKY_TV_RE = /\b(6[0-9]|7[0-9]|8[0-9])\s*("|inch|in)\b.*\btv\b|\btv\b.*\b(6[0-9]|7[0-9]|8[0-9])\s*("|inch|in)\b/i;

export function isBulky(title = '', category = '') {
  const text = `${title} ${category}`;
  return BULKY_RE.test(text) || BULKY_TV_RE.test(text);
}

// Local asking prices already sit in the local market, so the venue carries no
// further discount — the haggle gap lives in LOCAL_ASK_TO_REALIZED instead.
// Applying both would discount the same thing twice.
export const BULKY_VENUES = {
  facebook: {
    share: 1.0,
    fee_rate: 0.0,
    flat_fee: 0.0,
    ships: false,
    price_factor: 1.0,
  },
};

export const LOCAL_ASK_TO_REALIZED = 0.85;
export const MIN_LOCAL_COMPS = 4;

export const VENUES = {
  facebook: {
    share: 0.667,
    // Local cash sale: no platform cut, no shipping. But a local buyer pool
    // haggles, so realized price lands below the national comp.
    fee_rate: 0.0,
    flat_fee: 0.0,
    ships: false,
    price_factor: 0.85,
  },
  ebay: {
    share: 0.333,
    fee_rate: 0.1325,
    flat_fee: 0.4,
    ships: true,
    price_factor: 1.0,
  },
};

// Asking prices sit above realized prices; discount active-listing medians.
export const ACTIVE_TO_REALIZED = 0.8;

// Retail anchor is list price for a new unit, so condition does the work.
export const RETAIL_ANCHOR_WEIGHT = 0.45;
export const ACTIVE_ANCHOR_WEIGHT = 0.55;

export const SHIPPING = {
  // Crude weight-free estimate by price band until outcome data replaces it.
  default_outbound: 14.0,
  bands: [
    { max: 40, cost: 8.0 },
    { max: 150, cost: 14.0 },
    { max: 500, cost: 25.0 },
    { max: Infinity, cost: 45.0 },
  ],
};

export const PICKUP = {
  cost_per_mile: 0.35,
  round_trip: true,
  max_distance_mi: 40,
};

// Confidence combines three signals as a WEIGHTED GEOMETRIC MEAN, not a raw
// product. Multiplying them compounds cubically — three 0.7s would collapse to
// 0.34 — which let the confidence inputs swamp profit and ROI in the ranking.
// The geometric mean keeps a weak link damaging (a zero still zeroes it) while
// leaving the result on the same 0-1 scale as its inputs.
export const CONFIDENCE = {
  match_weight: 1.0, // trust in the product identification
  comp_depth_weight: 1.0, // how many comps backed the valuation
  condition_weight: 1.0, // trust in the condition read
  comp_depth_target: 8, // comps needed for full depth credit
  comp_depth_floor: 0.25, // thin comps still give a real price signal
  unknown_condition: 0.2, // used when nothing in the text signals condition
};

export const SCORING = {
  alpha: 0.5, // ROI exponent — dampens tiny-ticket, high-ROI noise
  beta: 1.0, // confidence exponent
  gamma: 0.5, // liquidity exponent
  min_profit: 25,
  // 0.70 on the geometric-mean scale filters the same listings that 0.35 did
  // on the old product scale; only the spread between survivors changed.
  min_confidence: 0.7,
  min_roi: 0.25,
};

export function confidenceFor({ matchScore, nComps, conditionConfidence }) {
  const depth = Math.max(
    CONFIDENCE.comp_depth_floor,
    Math.min(1, (nComps ?? 0) / CONFIDENCE.comp_depth_target)
  );

  const parts = [
    [Math.max(0, matchScore ?? 0), CONFIDENCE.match_weight],
    [depth, CONFIDENCE.comp_depth_weight],
    [Math.max(0, conditionConfidence ?? CONFIDENCE.unknown_condition), CONFIDENCE.condition_weight],
  ];

  const totalWeight = parts.reduce((sum, [, w]) => sum + w, 0);
  if (!totalWeight) return 0;
  if (parts.some(([v]) => v === 0)) return 0;

  const logSum = parts.reduce((sum, [v, w]) => sum + w * Math.log(v), 0);
  return Math.exp(logSum / totalWeight);
}

export function shippingFor(price) {
  const band = SHIPPING.bands.find((b) => price <= b.max);
  return band ? band.cost : SHIPPING.default_outbound;
}

export function pickupCost(distanceMi) {
  if (distanceMi == null) return 0;
  const miles = PICKUP.round_trip ? distanceMi * 2 : distanceMi;
  return miles * PICKUP.cost_per_mile;
}

export function haversineMi(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null)) return null;
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
