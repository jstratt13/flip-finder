// Listing title -> canonical product key.
//
// The key's job is to group listings that should share the same comps, not to
// be a true catalogue id. Getting this wrong is the worst failure mode in the
// system: a bad match invents a comp and manufactures fake profit, so anything
// weakly matched is scored with low confidence and gated out of the ranking.

import { bulkyTerm, isBulky } from './config.js';
import { identity } from './identity.js';

// Bump whenever a change here would give an existing listing a different key.
// resolve re-matches every listing below this version, so fixes reach listings
// that were already scored instead of only new captures.
//
// 3: keys and scores come from identity.js — its brand vocabulary, generations
// ("iphone 12" ≠ "iphone 13"), variants, capacity; colour and sale chatter out.
export const MATCHER_VERSION = 3;

// Spellings of one brand that must share a key. identity.js reports the brand
// as written, so "Polk Audio PSW505" and "Polk PSW505" name different brands
// there; here they are the same product.
const BRAND_KEYS = new Map([
  ['polk audio', 'polk'], ['audio technica', 'audiotechnica'], ['audio-technica', 'audiotechnica'],
  ['snap on', 'snapon'], ['snap-on', 'snapon'], ['tp link', 'tplink'], ['tp-link', 'tplink'],
  ['air jordan', 'jordan'], ['dr martenz', 'drmartens'], ['dr martens', 'drmartens'],
  ['wd', 'westerndigital'], ['western digital', 'westerndigital'], ['moto', 'motorola'],
  ['roomba', 'irobot'], ['herman miller', 'hermanmiller'],
]);
const brandKey = (brand) => (brand ? BRAND_KEYS.get(brand) ?? brand.replace(/[\s-]+/g, '') : null);

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

// "late-2013" and "2018" are model years, not model numbers. Treating them as
// identifiers makes every item from the same year look like the same product,
// but the year still separates products ("late-2013 iMac" ≠ "late-2015 iMac").
const isYearLike = (t) => /^(late|early|mid)?-?(19|20)\d{2}$/.test(t);

// Brands that are also ordinary words ("Ping Pong Table", "Harvard Foosball",
// "Coach"). Alone they don't name a product; with a model code or generation
// they do ("Air Jordan 4", "Event PS6").
const WORD_BRANDS = new Set([
  'ping', 'event', 'coach', 'giant', 'victor', 'harvard', 'mesa', 'boss', 'infinity', 'realistic',
  'shark', 'ninja', 'interstate', 'specialized', 'jordan', 'lloyd', 'wilson', 'brother', 'remington',
  'parsec', 'rogue', 'meta', 'valve',
]);

// How sure the key is to name one product, by what the title identifies.
// Same scale as before identity.js: a noun or loose words (0.3) can never reach
// the confidence gate, so those listings are "too vague to price".
const STRENGTH_SCORE = {
  'brand+code': [0.9, 'brand+model'],
  code: [0.7, 'model'],
  'brand+noun': [0.55, 'brand+terms'],
  none: [0.3, 'terms'],
};

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

  // The word in front of the type says which kind it is: a pool table, a poker
  // table and a foosball table are three products, and keying them all as
  // "table" priced them from one pool of comps at an identical $300.
  const at = tokens.findIndex((t) => t === termWords[0] || t.replace(/s$/, '') === termWords[0]);
  const before = at > 0 ? tokens[at - 1] : null;
  const kind =
    before && !NOISE.has(before) && !MATERIALS.has(before) && !FORMS.has(before) &&
    before !== brand && before.length >= 3 && !/^\d/.test(before)
      ? [before]
      : [];

  const kept = [...new Set([...(brand ? [brand] : []), ...kind, type, ...modifiers.slice(0, 3)])];

  let score;
  let method;
  if (brand && (modifiers.length || kind.length)) {
    score = 0.72;
    method = 'bulky:brand+type+attrs';
  } else if (modifiers.length || kind.length) {
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

  const tokens = norm.split(' ').filter(Boolean).map((t) => ALIASES.get(t) ?? t);
  const id = identity(title);
  const brandWords = (id.brand ?? '').split(/[\s-]+/);

  // A year written into a code ("late2013") is a model year, not a model code.
  const years = id.codes.filter(isYearLike).concat(id.attributes.filter((a) => /^(19|20)\d{2}$/.test(a)));
  const codes = id.codes.filter((c) => !isYearLike(c));
  const specific = codes.length > 0 || id.generations.length > 0;
  const brand = WORD_BRANDS.has(id.brand) && !specific ? null : brandKey(id.brand);

  if (isBulky(norm, category)) {
    const bulky = matchBulky(tokens, brand, bulkyTerm(norm, category));
    if (bulky) return bulky;
  }

  // "Litter Robot 3" and "Bose 301": the brand is already in the key, so the
  // generation is its number alone — "Dr Martens 1460" and "Dr.Martenz 1460"
  // then agree.
  const generations = id.generations.map((g) => {
    const [w, n] = g.split(' ');
    return brandWords.includes(w) ? n : w + n;
  });

  // The key names the product and the variants that set its price — iPhone 13
  // Pro 256GB is not iPhone 13 128GB — and nothing that doesn't: colour,
  // condition, sale chatter, the noun the seller happened to use. Without a
  // code or generation, the title's describing words are all there is.
  const capacity = id.attributes.filter((a) => /^\d+(gb|tb)$/.test(a)).slice(0, 1);
  const describing = specific
    ? []
    : id.query.split(' ').filter((w) => w && !brandWords.includes(w) && !id.variants.includes(w) && !capacity.includes(w));
  const kept = new Set([
    ...(brand ? [brand] : []),
    ...codes.slice(0, 2),
    ...generations.slice(0, 1),
    ...id.variants,
    ...capacity,
    ...years.slice(0, 1),
    // A code with no brand ("M200 speakers") needs its noun to not collide
    // with every other maker's M200. A generation names its own line.
    ...(codes.length && !id.generations.length && !brand ? id.nouns.slice(0, 1) : []),
    ...describing.slice(0, 3),
  ]);

  if (!kept.size) return null;

  // A brand with nothing else ("Women's Nike") is every product it makes.
  const strength = specific
    ? (brand ? 'brand+code' : 'code')
    : brand && describing.length
      ? 'brand+noun'
      : 'none';
  const [score, method] = STRENGTH_SCORE[strength];

  return {
    // Sorted so word-order variants of the same item collapse together.
    product_key: [...kept].sort().join('-'),
    brand,
    model: [...codes.slice(0, 2), ...generations.slice(0, 1)].join(' ') || null,
    match_score: score,
    method,
    // What eBay is searched for; resolve builds the same from identity().
    query: id.query || [...kept].join(' '),
  };
}
