// Listing title -> canonical product key.
//
// The key's job is to group listings that should share the same comps, not to
// be a true catalogue id. Getting this wrong is the worst failure mode in the
// system: a bad match invents a comp and manufactures fake profit, so anything
// weakly matched is scored with low confidence and gated out of the ranking.

import { bulkyTerm, isBulky } from './config.js';

// Bump whenever a change here would give an existing listing a different key.
// resolve re-matches every listing below this version, so fixes reach listings
// that were already scored instead of only new captures.
export const MATCHER_VERSION = 2;

const BRANDS = new Set([
  'apple', 'samsung', 'sony', 'lg', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'msi',
  'microsoft', 'google', 'nintendo', 'bose', 'sonos', 'jbl', 'beats', 'sennheiser',
  'audiotechnica', 'shure', 'yamaha', 'pioneer', 'denon', 'marantz', 'klipsch',
  'canon', 'nikon', 'fujifilm', 'gopro', 'dji', 'panasonic', 'olympus', 'leica',
  'dyson', 'kitchenaid', 'vitamix', 'weber', 'traeger', 'milwaukee', 'dewalt',
  'makita', 'ryobi', 'bosch', 'ridgid', 'craftsman', 'snapon', 'stihl', 'honda',
  'peloton', 'nordictrack', 'bowflex', 'trek', 'specialized', 'cannondale', 'giant',
  'herman', 'steelcase', 'ikea', 'wyze', 'roku', 'tcl', 'vizio', 'hisense',
  'razer', 'logitech', 'corsair', 'steelseries', 'redragon', 'keychron', 'anker',
  'garmin', 'fitbit', 'oculus', 'meta', 'valve', 'playstation', 'xbox',
]);

// Words that describe the transaction or the condition, not the product.
const NOISE = new Set([
  'for', 'sale', 'sell', 'selling', 'obo', 'firm', 'cash', 'only', 'price',
  'negotiable', 'pickup', 'pick', 'up', 'local', 'delivery', 'must', 'go',
  'brand', 'new', 'used', 'like', 'mint', 'excellent', 'great', 'good', 'fair',
  'condition', 'works', 'working', 'perfect', 'perfectly', 'barely', 'hardly',
  'gently', 'lightly', 'never', 'opened', 'sealed', 'box', 'boxed', 'open',
  'the', 'a', 'an', 'and', 'with', 'w', 'in', 'on', 'of', 'to', 'my', 'this',
  'free', 'cheap', 'best', 'offer', 'available', 'still', 'nice', 'clean',
  'read', 'description', 'please', 'text', 'call', 'serious', 'inquiries',
  'set', 'lot', 'pair', 'piece', 'pcs', 'item', 'items',
]);

// Deliberately does NOT fold ps4/ps5 into "playstation": the generation digit
// is the whole identity, and collapsing it would give a PS4 the PS5's comps.
const ALIASES = new Map([
  ['audio-technica', 'audiotechnica'],
  ['snap-on', 'snapon'],
]);

function normalize(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\$\s?[\d,.]+/g, ' ')
    .replace(/[^a-z0-9\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A model number is the most identifying token available without a catalogue:
// it mixes letters and digits (K628, WH-1000XM4, RTX3080).
const hasLetterAndDigit = (t) => /[a-z]/.test(t) && /\d/.test(t);

// "late-2013" and "2018" are model years, not model numbers. Treating them as
// identifiers makes every item from the same year look like the same product.
const isYearLike = (t) => /(^|-)(19|20)\d{2}$/.test(t);

// Bulky goods have no model numbers, so the honest comparable is a type plus
// its distinguishing attributes: "brown leather sectional", "queen mattress".
// Less precise than a SKU, but it is what a local buyer is actually comparing.
const MATERIALS = new Set([
  'leather', 'fabric', 'velvet', 'microfiber', 'suede', 'linen', 'canvas',
  'oak', 'walnut', 'pine', 'teak', 'maple', 'mahogany', 'cherry', 'birch',
  'metal', 'steel', 'glass', 'marble', 'granite', 'quartz', 'wicker', 'rattan',
  'bamboo', 'plastic', 'wood', 'wooden', 'upholstered',
]);

const FORMS = new Set([
  'sectional', 'loveseat', 'sleeper', 'convertible', 'reclining', 'swivel',
  'queen', 'king', 'twin', 'full', 'california', 'bunk', 'daybed',
  'round', 'rectangular', 'square', 'oval', 'counter', 'bar', 'drawer',
  'dining', 'coffee', 'console', 'accent', 'patio', 'outdoor', 'standing',
]);

function matchBulky(tokens, brand, term) {
  if (!term) return null;
  // Multi-word terms ("hot tub") become one key segment; plurals collapse so
  // "chairs" and "chair" share a comp pool.
  const type = term.replace(/\s+/g, '-');
  const termWords = term.split(/\s+/);

  const modifiers = tokens.filter(
    (t) => !termWords.includes(t.replace(/s$/, '')) && !termWords.includes(t) && (MATERIALS.has(t) || FORMS.has(t))
  );

  const kept = [...new Set([...(brand ? [brand] : []), type, ...modifiers.slice(0, 3)])];

  let score;
  let method;
  if (brand && modifiers.length) {
    score = 0.72;
    method = 'bulky:brand+type+attrs';
  } else if (modifiers.length) {
    score = 0.65;
    method = 'bulky:type+attrs';
  } else if (brand) {
    score = 0.65;
    method = 'bulky:brand+type';
  } else {
    score = 0.5;
    method = 'bulky:type';
  }

  return {
    // Prefixed so comp resolution routes these to local listings rather than
    // eBay, where furniture comps barely exist.
    product_key: `local:${[...kept].sort().join('-')}`,
    brand,
    model: null,
    type,
    bulky: true,
    match_score: score,
    method,
    // The key is deliberately coarse so similar items group together, but the
    // query stays specific — it's what the eBay fallback searches when there
    // aren't enough local comps yet, and "herman chair" would find nothing.
    query: tokens.filter((t) => !NOISE.has(t) && t.length > 1).slice(0, 6).join(' '),
  };
}

export function matchProduct(title, category = '') {
  const norm = normalize(title);
  if (!norm) return null;

  const rawTokens = norm.split(' ').filter(Boolean);
  const tokens = rawTokens.map((t) => ALIASES.get(t) ?? t);

  const brand = tokens.find((t) => BRANDS.has(t)) ?? null;

  if (isBulky(norm, category)) {
    const bulky = matchBulky(tokens, brand, bulkyTerm(norm, category));
    if (bulky) return bulky;
  }

  const modelTokens = tokens.filter(
    (t) => t !== brand && hasLetterAndDigit(t) && !isYearLike(t) && t.length >= 2
  );

  const content = tokens.filter(
    (t) => t !== brand && !NOISE.has(t) && !modelTokens.includes(t) && t.length > 2
  );

  // Bare numbers only mean something next to a product name ("ipad mini 6").
  const numeric = rawTokens.filter((t) => /^\d{1,4}$/.test(t) && content.length);

  const kept = new Set([
    ...(brand ? [brand] : []),
    ...modelTokens.slice(0, 2),
    ...content.slice(0, 3),
    ...(modelTokens.length ? [] : numeric.slice(0, 1)),
  ]);

  if (!kept.size) return null;

  // Key is sorted so word-order variants of the same item collapse together;
  // the query keeps title order because that is what reads as a real search.
  const keyParts = [...kept].sort();
  const query = [...new Set(tokens.filter((t) => kept.has(t)))].join(' ');

  let score;
  let method;
  if (brand && modelTokens.length) {
    score = 0.9;
    method = 'brand+model';
  } else if (modelTokens.length) {
    score = 0.7;
    method = 'model';
  } else if (brand && content.length) {
    score = 0.55;
    method = 'brand+terms';
  } else {
    score = 0.3;
    method = 'terms';
  }

  return {
    product_key: keyParts.join('-'),
    brand,
    model: modelTokens.slice(0, 2).join(' ') || null,
    match_score: score,
    method,
    query,
  };
}
