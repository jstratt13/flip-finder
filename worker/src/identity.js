// Listing identity for eBay pricing.
//
// Reads what identifies a product in a listing title (brand, model code,
// generation) apart from what merely describes it (capacity, colour, year,
// condition, sale chatter), builds an eBay query from the identity alone, and
// judges whether an eBay result is that product.
import { PRODUCT_NOUNS, CATEGORY_BRANDS } from './identity-vocab.js';

// Brands, single- and multi-word. The production matcher's list plus what the
// 360 stored listings and the eBay sample showed it missing.
const BRAND_LIST = [
  ...CATEGORY_BRANDS,
  'apple', 'samsung', 'sony', 'lg', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'msi', 'microsoft', 'google',
  'nintendo', 'bose', 'sonos', 'jbl', 'beats', 'sennheiser', 'audio technica', 'audio-technica', 'shure',
  'yamaha', 'pioneer', 'denon', 'marantz', 'klipsch', 'canon', 'nikon', 'fujifilm', 'gopro', 'dji',
  'panasonic', 'olympus', 'leica', 'dyson', 'kitchenaid', 'vitamix', 'weber', 'traeger', 'milwaukee',
  'dewalt', 'makita', 'ryobi', 'bosch', 'ridgid', 'craftsman', 'snap on', 'stihl', 'peloton', 'nordictrack',
  'bowflex', 'trek', 'specialized', 'cannondale', 'giant', 'herman miller', 'steelcase', 'ikea', 'wyze',
  'roku', 'tcl', 'vizio', 'hisense', 'razer', 'logitech', 'corsair', 'steelseries', 'redragon', 'keychron',
  'anker', 'garmin', 'fitbit', 'oculus', 'meta', 'valve', 'playstation', 'xbox', 'amazon', 'fire tv', 'kindle',
  // missed by the production matcher
  'polk audio', 'polk', 'onkyo', 'harman kardon', 'infinity', 'kenwood', 'sansui', 'realistic', 'technics',
  'mcintosh', 'nad', 'cambridge audio', 'definitive technology', 'monoprice', 'atlantic technology',
  'middle atlantic', 'panamax', 'furman', 'russound', 'urc', 'tara labs', 'synergistic research', 'roland',
  'korg', 'fender', 'gibson', 'boss', 'line 6', 'akai', 'event', 'thecus', 'synology', 'qnap', 'seagate',
  'western digital', 'wd', 'crucial', 'micron', 'kingston', 'sandisk', 'netgear', 'tp link', 'tp-link',
  'linksys', 'ubiquiti', 'motorola', 'moto', 'oneplus', 'nokia', 'irobot', 'roomba', 'shark', 'ninja',
  'cuisinart', 'breville', 'keurig', 'nespresso', 'instant pot', 'bambu lab', 'prusa', 'creality', 'elegoo',
  'texas instruments', 'casio', 'lexmark', 'brother', 'epson', 'xerox', 'ricoh', 'litter robot',
  'dr martens', 'dr martenz', 'nike', 'jordan', 'air jordan', 'adidas', 'new balance', 'gucci', 'prada',
  'louis vuitton', 'coach', 'patagonia', 'north face', 'arcteryx', 'lululemon', 'yeti', 'hydro flask',
  'ozark trail', 'coleman', 'victor', 'yonex', 'wilson', 'callaway', 'titleist', 'taylormade', 'ping',
  'rogue', 'rep fitness', 'harvard', 'bretford', 'interstate', 'mesa', 'motopower', 'sangean', 'lloyd',
  'remington', 'parsec', 'google fiber', 'sp5der', 'lego', 'funko', 'pokemon',
];

const NOISE = new Set([
  'for', 'sale', 'sell', 'selling', 'obo', 'firm', 'cash', 'only', 'price', 'reduced', 'negotiable',
  'pickup', 'pick', 'up', 'local', 'delivery', 'must', 'go', 'take', 'brand', 'new', 'used', 'like',
  'mint', 'excellent', 'great', 'good', 'fair', 'condition', 'works', 'working', 'tested', 'perfect',
  'perfectly', 'barely', 'hardly', 'gently', 'lightly', 'slightly', 'never', 'unused', 'opened', 'sealed',
  'box', 'boxed', 'nib', 'nwt', 'open', 'the', 'a', 'an', 'and', 'or', 'with', 'w', 'in', 'on', 'of', 'to',
  'my', 'this', 'free', 'cheap', 'best', 'offer', 'available', 'approx', 'still', 'nice', 'clean', 'read',
  'description', 'please', 'text', 'call', 'serious', 'inquiries', 'set', 'lot', 'pair', 'piece', 'pcs',
  'item', 'items', 'moving', 'garage', 'estate', 'vintage', 'rare', 'authentic', 'genuine', 'original',
  'oem', 'very', 'hours', 'hrs', 'bundle', 'edition', 'collection', 'made', 'japan', 'usa', 'high', 'low',
  'quality', 'heavy', 'duty', 'only', 'per', 'each', 'bulk', 'all', 'size', 'sz', 'factory', 'unlocked',
  'locked', 'mens', 'men', 'womens', 'women', 'kids', 'as', 'is', 'includes', 'included', 'comes',
]);

// Describe a variant, not the product: colour, capacity, dimensions, power.
const COLOURS = new Set([
  'black', 'white', 'silver', 'gray', 'grey', 'blue', 'red', 'green', 'gold', 'rose', 'pink', 'purple',
  'yellow', 'orange', 'brown', 'tan', 'beige', 'midnight', 'starlight', 'graphite', 'space', 'navy',
  'metallic', 'metalic', 'chrome', 'matte', 'glossy', 'piano',
]);
const ATTRIBUTE_RE = /^\d+(\.\d+)?(gb|tb|mb|w|watt|watts|v|volt|mah|ah|in|inch|inches|mm|cm|ft|hz|khz|ohm|ohms|lb|lbs|oz|qt|g|k|x|hours|hour|hrs|hr|pack|pk|pc|pcs|ct|count|ch|channel)$/;
const YEAR_RE = /^(19|20)\d{2}$/;

// Variant words change the product and its price: an iPhone 13 Pro is not an
// iPhone 13. A result carrying one the listing lacks (or the reverse) is a
// different product.
const VARIANTS = new Set(['pro', 'max', 'plus', 'mini', 'ultra', 'lite', 'se', 'slim', 'xl', 'combo', 'deluxe', 'elite']);

// Product lines sold by generation number, whatever the brand text says.
const LINE_NAMES = new Set([
  'iphone', 'ipad', 'ipod', 'galaxy', 'pixel', 'note', 'watch', 'series', 'gen', 'generation', 'mark',
  'mk', 'version', 'ps', 'playstation', 'switch', 'kindle', 'echo', 'surface', 'xps', 'thinkpad',
  'chromebook', 'roomba', 'robot', 'acoustimass', 'soundlink', 'quietcomfort', 'qc', 'airpods',
  'retro', 'jordan', 'dunk', 'model', 'type',
]);

// Words that make the number before them a quantity or a measurement.
const UNIT_WORDS = new Set([
  'outlet', 'outlets', 'pin', 'pins', 'amp', 'amps', 'million', 'lb', 'lbs', 'ft', 'feet', 'foot', 'inch',
  'watt', 'watts', 'volt', 'volts', 'pack', 'piece', 'pieces', 'port', 'ports', 'channel', 'track',
  'tracks', 'band', 'bay', 'gallon', 'quart', 'cup', 'cups', 'speed', 'way', 'drawer', 'shelf', 'person',
  'seat', 'burner', 'slice', 'station', 'string', 'key', 'keys', 'button', 'games', 'game', 'player',
]);

const NOUNS = new Set(PRODUCT_NOUNS.filter((n) => !n.includes(' ')));
const ACCESSORY_WORDS = new Set([
  'case', 'cover', 'charger', 'adapter', 'adaptor', 'battery', 'batteries', 'stand', 'mount', 'cable',
  'cord', 'protector', 'skin', 'strap', 'band', 'replacement', 'parts', 'part', 'kit', 'decal', 'sticker',
  'manual', 'box', 'shell', 'housing', 'dock', 'holder', 'bag', 'sleeve', 'lens', 'filter', 'extruder',
  'plate', 'plates', 'knob', 'cables', 'chargers', 'controller', 'controllers', 'screen', 'grill',
]);

export function normalize(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // 14" and 14” are sizes: keep them attached so they read as inches, not a
    // generation ("Chromebook 14").
    .replace(/(\d)\s*("|”|''|inch(es)?\b)/g, '$1in ')
    // 6' is feet, not a generation ("Dell 6' power cords").
    .replace(/(\d)['’](?![a-z])/g, '$1ft ')
    .replace(/[’'`]/g, '')
    // "Dr.Martens" is two words; "4.5" is one number.
    .replace(/([a-z])\.(?=[a-z])/g, '$1 ')
    .replace(/[^a-z0-9.\-/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens, with hyphenated and slashed words kept whole and also split, so
// "MX-880", "MX 880" and "MX880" all produce the joined form "mx880".
export function tokens(title) {
  return tokensOf(normalize(title));
}

// Same, from text already normalized — the judge normalizes each result once.
function tokensOf(normalized) {
  const words = normalized.split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[.\-/]+|[.\-/]+$/g, '');
    if (!w) continue;
    if (/[-/]/.test(w)) {
      const parts = w.split(/[-/]/).filter(Boolean);
      out.push({ t: w.replace(/[-/.]/g, ''), raw: w, joined: true });
      for (const p of parts) out.push({ t: p, raw: p, part: true });
    } else {
      out.push({ t: w.replace(/\./g, ''), raw: w });
    }
  }
  return out;
}

const hasLetter = (s) => /[a-z]/.test(s);
const hasDigit = (s) => /\d/.test(s);

// The first brand named is the product; later ones are what came with it
// ("Sansui 5000A Receiver + Infinity Primus 250 Speakers"). At the same spot the
// longest wins, so "Polk Audio" beats "Polk".
const BRANDS = new Map(BRAND_LIST.map((b) => [b.replace(/-/g, ' '), b]));
const BRAND_MAX_WORDS = Math.max(...[...BRANDS.keys()].map((b) => b.split(' ').length));
function findBrand(norm) {
  const words = norm.replace(/[-/]/g, ' ').split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(BRAND_MAX_WORDS, words.length - i); n >= 1; n--) {
      const b = BRANDS.get(n === 1 ? words[i] : words.slice(i, i + n).join(' '));
      if (b) return b;
    }
  }
  return null;
}

// What makes this listing this product.
export function identity(title) {
  const norm = normalize(title);
  const brand = findBrand(norm);
  const brandWords = new Set((brand ?? '').split(/[\s-]+/));
  const toks = tokens(title);
  const plain = toks.filter((x) => !x.part);

  const codes = [];
  const generations = [];
  const nouns = [];
  const attributes = [];
  const variants = [];
  const lines = [];

  for (let i = 0; i < plain.length; i++) {
    const { t, raw } = plain[i];
    if (brandWords.has(t)) continue;
    if (NOISE.has(t) || COLOURS.has(t)) continue;
    if (YEAR_RE.test(t) || ATTRIBUTE_RE.test(t) || /^\d+\/\d+/.test(raw) || /^\d+\.\d+$/.test(raw)) { attributes.push(t); continue; }
    if (VARIANTS.has(t)) { variants.push(t); continue; }

    if (hasLetter(t) && hasDigit(t) && t.length >= 2) {
      // "5g" is a network, "4k" a resolution: attributes, not model codes.
      if (/^\d[a-z]$/.test(t) || ['5g', '4g', '4k', '8k', '1080p', '720p', '2in1', '3d'].includes(t)) {
        attributes.push(t);
        continue;
      }
      codes.push(t);
      continue;
    }

    // A bare number is a generation or model only right after the brand, a
    // product line, a variant or a known line name: "iphone 13", "slim 3",
    // "litter robot 3", "photosmart 6525", "monitor 10". After an ordinary word
    // it's a count or a size ("8 outlet", "5 million", "radio 4"), and a unit
    // word right after it confirms that.
    if (/^\d{1,4}$/.test(t)) {
      const prev = plain[i - 1]?.t;
      const next = plain[i + 1]?.t;
      const namesIt = prev && (brandWords.has(prev) || lines.includes(prev) || VARIANTS.has(prev) || LINE_NAMES.has(prev));
      if (namesIt && !UNIT_WORDS.has(next)) generations.push(`${prev} ${t}`);
      continue;
    }

    if (NOUNS.has(t) || NOUNS.has(t.replace(/s$/, ''))) { nouns.push(t.replace(/s$/, '')); continue; }
    // An unrecognised word right after the brand is usually a product line:
    // "Seagate BarraCuda", "Sony XDCAM", "Bose Wave". It goes in the query but
    // isn't required of results — lines are written too inconsistently.
    if (brand && t.length >= 3 && !hasDigit(t) && i > 0 && brandWords.has(plain[i - 1]?.t)) lines.push(t);
  }

  const specific = Boolean(codes.length || generations.length);
  // Capacity sets the price of storage and phones (3TB vs 1TB, 128GB vs 512GB),
  // so it stays in the search even though it isn't identity.
  const capacity = attributes.filter((a) => /^\d+(gb|tb)$/.test(a)).slice(0, 1);
  // Without a code or generation, the brand alone searches far too wide
  // ("moto", "gucci"). Keep the title's other descriptive words, minus chatter.
  const describing = specific
    ? []
    : toks
        .filter((p) => !p.joined)
        .map((p) => p.t)
        .filter((t) => !brandWords.has(t) && !NOISE.has(t) && !COLOURS.has(t) && hasLetter(t) && t.length >= 2 && !ATTRIBUTE_RE.test(t))
        .slice(0, 4);
  const queryParts = [
    ...(brand ? [brand] : []),
    ...lines.slice(0, 1),
    ...codes.slice(0, 2).map((c) => plain.find((p) => p.t === c)?.raw ?? c),
    ...generations.slice(0, 1),
    ...variants,
    ...(specific ? nouns.slice(0, 1) : describing),
    ...capacity,
  ];
  const query = [...new Set(queryParts.join(' ').split(' '))].join(' ').trim();

  return {
    brand, lines, codes, generations, variants, nouns, attributes, query,
    allWords: plain.map((x) => x.t),
    lot: plain.some((x) => x.t === 'lot'),
    strength: brand && specific ? 'brand+code' : specific ? 'code' : brand && nouns.length ? 'brand+noun' : brand ? 'brand' : nouns.length ? 'noun' : 'none',
  };
}

// Is this eBay result the product the listing is selling?
// Regexes that depend only on the listing, built once per identity rather than
// once per eBay result: judging a run's results was ~6 ms warm before this.
function compiled(id) {
  if (id._re) return id._re;
  const re = {
    shortCode: new Map(id.codes.filter((c) => c.length < 5).map((c) => [c, new RegExp(`[0-9a-z]${c}|${c}[0-9a-z]`)])),
    generation: id.generations.map((g) => {
      const [w, n] = g.split(' ');
      return new RegExp(`(^|\\s)${w}\\s?${n}(\\s|$)`);
    }),
  };
  Object.defineProperty(id, '_re', { value: re, enumerable: false });
  return re;
}

export function judgeResult(resultTitle, id) {
  const normalized = normalize(resultTitle);
  const toks = tokensOf(normalized);
  const set = new Set(toks.map((x) => x.t));
  const norm = ` ${normalized.replace(/[-/]/g, ' ')} `;
  const squashed = normalized.replace(/[^a-z0-9]/g, '');
  const re = compiled(id);

  const brandOk = !id.brand || norm.includes(` ${id.brand.replace(/-/g, ' ')} `);
  // Short codes must stand alone (R10 is not R100). Long ones may run into the
  // next code, as part numbers do: "6870EC9081C".
  const codeHits = id.codes.filter(
    (c) => set.has(c) || (c.length >= 5 ? squashed.includes(c) : squashed.includes(c) && !re.shortCode.get(c).test(squashed))
  );
  const genOk = re.generation.every((r) => r.test(norm));

  if (!id.brand && !id.codes.length && !id.generations.length) return { relevant: null, why: 'nothing to check' };
  if (!brandOk && !codeHits.length) return { relevant: false, why: 'different brand' };
  // A listing naming several codes usually has one real one plus a revision or
  // companion part ("6870EC 9081C-2"): the longest must match, the rest may not.
  if (id.codes.length) {
    const primary = [...id.codes].sort((a, b) => b.length - a.length)[0];
    if (!codeHits.includes(primary)) return { relevant: false, why: 'model code missing' };
  }
  if (!genOk) return { relevant: false, why: 'different generation' };
  if (id.codes.length || id.generations.length) {
    const resultVariants = [...VARIANTS].filter((v) => set.has(v));
    const wanted = new Set(id.variants);
    if (resultVariants.some((v) => !wanted.has(v)) || id.variants.some((v) => !set.has(v))) {
      return { relevant: false, why: 'different variant' };
    }
  }

  // Where the listing's identity first appears in the result, by token — the
  // brand can sit at the end ("TI-89 Titanium … Texas Instruments").
  const identityWords = new Set([
    ...(id.brand ?? '').split(/[\s-]+/).filter(Boolean),
    ...id.codes,
    ...id.generations.map((g) => g.split(' ')[0]),
  ]);
  const words = toks.filter((x) => !x.part).map((x) => x.t);
  let first = words.findIndex((w) => identityWords.has(w) || id.codes.some((c) => c.length >= 5 && w.includes(c)));
  if (first === -1) first = words.length;
  const before = words.slice(0, first);
  const after = words.slice(first);

  // Accessories name the product they fit: "Battery for Sony PMW-EX1R".
  if (before.some((w) => ['for', 'fits', 'fit', 'compatible', 'replacement', 'replaces'].includes(w))) {
    return { relevant: false, why: 'accessory (for …)' };
  }
  if (before.some((w) => ACCESSORY_WORDS.has(w))) return { relevant: false, why: 'accessory (leading noun)' };

  // A compatibility list written with slashes is a part that fits many models:
  // "P2S/P1S/P1P/A1/X1C Build Plate". Space-separated cross-reference numbers are
  // normal on real parts ("6870EC9081C 6871EC1121E Control Board") and stay.
  if (id.codes.length || id.generations.length) {
    const slashLists = normalized.split(' ').filter((w) => w.includes('/'));
    if (slashLists.some((w) => w.split('/').filter((p) => hasLetter(p) && hasDigit(p)).length >= 3)) {
      return { relevant: false, why: 'fits many models' };
    }
  }
  if ((set.has('lot') || set.has('lots')) && !id.lot) return { relevant: false, why: 'lot' };

  // Same product line, different model year: a 2025 Moto G Power is not the 2024.
  if (id.codes.length || id.generations.length) {
    const want = new Set(id.attributes.filter((a) => YEAR_RE.test(a)));
    const got = words.filter((w) => YEAR_RE.test(w));
    if (want.size && got.length && !got.some((y) => want.has(y))) return { relevant: false, why: 'different model year' };
  }

  // An accessory named right after the product is the product being sold: "PS5
  // Slim Travel Case" is a case. Only the title's first segment counts — after a
  // comma, bullet or dash sellers list extras ("Remote, Charging Cord", "• Remote
  // & Power Cord Included"). Negated ("No Charger"), introduced ("with Adapter"),
  // or named in the listing itself, it isn't the product.
  const listingWords = new Set(id.allWords ?? []);
  const headSegment = normalize(String(resultTitle).split(/[,•|+&(]|\s-\s|\s–\s/)[0]);
  const head = tokens(headSegment).filter((x) => !x.part).map((x) => x.t);
  const headStart = head.findIndex((w) => identityWords.has(w) || id.codes.some((c) => c.length >= 5 && w.includes(c)));
  if (headStart !== -1) {
    const tail = head.slice(headStart);
    for (let i = 0; i < tail.length; i++) {
      const w = tail[i];
      if (!ACCESSORY_WORDS.has(w) || listingWords.has(w)) continue;
      const lead = tail.slice(Math.max(0, i - 3), i);
      if (lead.some((x) => ['with', 'w', 'includes', 'including', 'plus', 'and', 'no', 'without', 'missing'].includes(x))) continue;
      return { relevant: false, why: 'accessory (named after product)' };
    }
  }

  return { relevant: true, why: 'match' };
}
