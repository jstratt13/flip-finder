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

const BULKY_RE = new RegExp(`\\b(${BULKY_TERMS.join('|')})s?\\b`, 'gi');

// Large TVs are technically shippable and practically never are.
const BULKY_TV_RE = /\b(6[0-9]|7[0-9]|8[0-9])\s*("|inch|in)\b.*\btv\b|\btv\b.*\b(6[0-9]|7[0-9]|8[0-9])\s*("|inch|in)\b/i;

// A bulky word names what an accessory fits, not what it is: "Weber grill
// cover" is a $20 cover, but matched as a grill it is priced against local
// grill asks and ranks as a huge phantom profit — while dragging down the comp
// pool for real grills. Any of these words disqualifies the whole title.
//
// This errs deliberately. "Sectional with cushions" also drops out, and a
// non-bulky match on a sofa scores too low to rank. Losing a real sofa from
// the ranking costs one missed look; ranking a cover as a grill costs a drive.
export const BULKY_ACCESSORY_TERMS = [
  'cover', 'slipcover', 'cushion', 'pillow', 'topper', 'protector', 'sheet',
  'blade', 'battery', 'batteries', 'charger', 'filter', 'hose', 'bag', 'brush',
  'grate', 'knob', 'handle', 'hinge', 'bracket', 'caster', 'rail', 'bulb',
  'lamp', 'mat', 'extender', 'remote', 'part', 'parts', 'replacement',
  'accessory', 'accessories', 'paddle', 'fin',
];

const ACCESSORY_RE = new RegExp(`\\b(${BULKY_ACCESSORY_TERMS.join('|')})(s|es)?\\b`, 'i');

// Phrases where a bulky word is part of a small thing's name. Removed before
// the bulky test so the rest of the title is still judged on its own.
const NOT_BULKY_PHRASES = [
  /\b(toaster|dutch|pizza|microwave|convection)\s+ovens?\b/gi,
  /\b(hair|blow)\s+dryers?\b/gi,
  /\b(pressure|power)\s+washers?\b/gi,
  /\b(camp|camping|backpacking|portable)\s+stoves?\b/gi,
  /\b(dishwasher|microwave|oven|freezer|food)[\s-]+safe\b/gi,
  /\btable\s+(saw|runner|cloth)s?\b/gi,
  /\bbench\s+(grinder|vise|vice)s?\b/gi,
  /\bdesk\s+(organizer|fan|clock|speakers?|riser|clamp)s?\b/gi,
  /\b(dog|cat|pet|truck)\s+beds?\b/gi,
  /\b(side|rear\s?view|makeup|compact)\s+mirrors?\b/gi,
  /\bgrill\s+(pan|tools?)\b/gi,
  /\bsquat\s+proof\b/gi,
];

// Too ambiguous to count alone — "range extender", "price range", "safe for
// kids". These only mean the bulky thing when the title says so.
const NEEDS_CONTEXT = {
  range: /\b(gas|electric|induction|stove|oven|cooktop|burners?|kitchen)\b/i,
  safe: /\b(gun|rifle|fire\s?proof|vault|keypad|combination|biometric|liberty|sentry|cannon)\b/i,
};

function bulkyText(title, category) {
  const text = `${title} ${category}`;
  if (ACCESSORY_RE.test(text)) return null;
  return NOT_BULKY_PHRASES.reduce((t, re) => t.replace(re, ' '), text);
}

// The bulky term a title is about, singular, or null. Matching uses it as the
// item type, so it has to agree with isBulky or the two paths would disagree
// about what the listing is.
export function bulkyTerm(title = '', category = '') {
  const text = bulkyText(title, category);
  if (text == null) return null;
  for (const m of text.matchAll(BULKY_RE)) {
    const term = m[1].toLowerCase();
    if (NEEDS_CONTEXT[term] && !NEEDS_CONTEXT[term].test(text)) continue;
    return term;
  }
  return null;
}

export function isBulky(title = '', category = '') {
  if (bulkyTerm(title, category)) return true;
  const text = bulkyText(title, category);
  return text != null && BULKY_TV_RE.test(text);
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

// Capture is browse-triggered, so a listing going unseen means either it was
// removed or you simply didn't browse that category. Those are indistinguishable
// from here, which is why nothing is inferred from a short gap: the dashboard
// reports how long ago a listing was last confirmed and lets you judge.
//
// Only a long silence is treated as gone. Craigslist posts expire around 30 days
// anyway, so beyond that the listing is almost certainly dead regardless of
// browsing habits.
export const FRESHNESS = {
  // Marked 'gone' and dropped from the ranking after this long unseen.
  gone_after_days: 30,
  // Still ranked, but flagged in the UI as possibly no longer available.
  stale_after_days: 7,
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
