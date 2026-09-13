// Keyword categorisation. Sources rarely give us a usable category — Craigslist
// only exposes one when you browse by category, and Facebook's feed often has
// none at all — so the category is derived from the listing itself.
//
// Scored rather than first-match: a title hitting three furniture terms and one
// electronics term is furniture, and first-match would depend on list order.

export const CATEGORIES = [
  'electronics',
  'furniture',
  'appliances',
  'tools',
  'outdoor',
  'auto',
  'home',
  'apparel',
  'toys',
  'music',
  'other',
];

const TERMS = {
  electronics: [
    'tv', 'television', 'monitor', 'laptop', 'computer', 'pc', 'macbook', 'imac',
    'ipad', 'tablet', 'iphone', 'phone', 'android', 'pixel', 'galaxy', 'camera',
    'lens', 'dslr', 'headphones', 'earbuds', 'airpods', 'soundbar', 'receiver',
    'turntable', 'playstation', 'xbox', 'nintendo', 'console', 'gpu', 'graphics card',
    'ssd', 'hard drive', 'router', 'modem', 'printer', 'scanner', 'drone', 'projector',
    'webcam', 'kindle', 'smartwatch', 'apple watch', 'processor', 'motherboard',
    'mechanical keyboard', 'gaming keyboard', 'mouse', 'controller', 'stereo',
    'ps5', 'ps4', 'ps3', 'speaker', 'subwoofer', 'amplifier', 'bluray', 'blu-ray',
  ],
  furniture: [
    'couch', 'sofa', 'sectional', 'loveseat', 'recliner', 'chair', 'armchair',
    'table', 'desk', 'dresser', 'nightstand', 'bookshelf', 'bookcase', 'credenza',
    'armoire', 'wardrobe', 'headboard', 'bed frame', 'bedframe', 'mattress', 'futon',
    'ottoman', 'bench', 'barstool', 'stool', 'cabinet', 'hutch', 'vanity', 'shelving',
    'sideboard', 'chaise', 'daybed', 'bunk bed',
  ],
  appliances: [
    'refrigerator', 'fridge', 'freezer', 'washer', 'dryer', 'dishwasher', 'stove',
    'oven', 'range hood', 'microwave', 'vacuum', 'air conditioner', 'ac unit',
    'water heater', 'blender', 'air fryer', 'coffee maker', 'espresso', 'toaster',
    'stand mixer', 'garbage disposal', 'dehumidifier',
  ],
  tools: [
    'drill', 'impact driver', 'circular saw', 'miter saw', 'table saw', 'sander',
    'grinder', 'wrench', 'socket set', 'toolbox', 'tool chest', 'air compressor',
    'welder', 'ladder', 'nail gun', 'nailer', 'lathe', 'planer', 'jigsaw', 'chainsaw',
    'pressure washer', 'generator', 'shop vac', 'workbench',
  ],
  outdoor: [
    'bike', 'bicycle', 'mountain bike', 'kayak', 'canoe', 'paddleboard', 'surfboard',
    'skis', 'snowboard', 'golf clubs', 'tent', 'camping', 'cooler', 'fishing rod',
    'dumbbell', 'barbell', 'weight bench', 'squat rack', 'treadmill', 'elliptical',
    'peloton', 'kettlebell', 'scooter', 'skateboard', 'patio set', 'grill', 'smoker',
    'lawn mower', 'mower', 'trampoline',
  ],
  auto: [
    'tires', 'wheels', 'rims', 'engine', 'transmission', 'bumper', 'headlight',
    'taillight', 'catalytic', 'alternator', 'radiator', 'exhaust', 'muffler',
    'car seat', 'roof rack', 'tonneau', 'oem', 'truck bed', 'brake',
  ],
  home: [
    'rug', 'mirror', 'lamp', 'curtains', 'bedding', 'comforter', 'cookware',
    'pots and pans', 'dishes', 'flatware', 'vase', 'artwork', 'picture frame',
    'planter', 'chandelier', 'ceiling fan', 'shower', 'faucet', 'tile',
  ],
  apparel: [
    'shoes', 'sneakers', 'boots', 'jacket', 'coat', 'dress', 'jeans', 'handbag',
    'purse', 'backpack', 'sunglasses', 'jewelry', 'necklace', 'ring', 'watch',
    'hoodie', 'designer',
  ],
  toys: [
    'lego', 'puzzle', 'board game', 'doll', 'action figure', 'nerf', 'playset',
    'stuffed animal', 'rc car', 'trading cards', 'pokemon', 'funko',
  ],
  music: [
    'guitar', 'bass guitar', 'drum kit', 'drums', 'piano', 'keyboard piano',
    'violin', 'saxophone', 'trumpet', 'ukulele', 'synthesizer', 'midi', 'amp head',
    'pedalboard', 'microphone', 'mixer board',
  ],
};

// Brand is often the only category signal present — "Nike Air Max size 11"
// names no garment and "Sonos Connect:Amp" no device type. Weighted below a
// single explicit term so real nouns still win, but enough to rescue a title
// that would otherwise fall to "other".
const BRAND_CATEGORY = {
  electronics: [
    'apple', 'samsung', 'sony', 'lg', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'msi',
    'microsoft', 'nintendo', 'bose', 'sonos', 'jbl', 'beats', 'sennheiser', 'canon',
    'nikon', 'gopro', 'dji', 'roku', 'tcl', 'vizio', 'hisense', 'razer', 'logitech',
    'corsair', 'anker', 'garmin', 'fitbit', 'oculus', 'playstation', 'xbox', 'denon',
  ],
  tools: ['dewalt', 'milwaukee', 'makita', 'ryobi', 'ridgid', 'craftsman', 'snap-on', 'stihl'],
  appliances: ['whirlpool', 'maytag', 'kenmore', 'frigidaire', 'dyson', 'kitchenaid', 'vitamix'],
  outdoor: ['weber', 'traeger', 'peloton', 'nordictrack', 'bowflex', 'trek', 'specialized', 'yeti'],
  apparel: ['nike', 'adidas', 'lululemon', 'patagonia', 'north face', 'carhartt', 'coach'],
  furniture: ['ikea', 'herman miller', 'steelcase', 'west elm', 'ashley', 'pottery barn'],
  music: ['fender', 'gibson', 'roland', 'korg', 'marshall', 'ludwig'],
};

const COMPILED_BRANDS = Object.entries(BRAND_CATEGORY).flatMap(([category, brands]) =>
  brands.map((b) => ({
    category,
    re: new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  }))
);

const BRAND_WEIGHT = 0.8;

// Built once: longer phrases score higher, so "mechanical keyboard" outweighs
// the bare "keyboard" that also appears under music.
const COMPILED = Object.entries(TERMS).map(([category, terms]) => ({
  category,
  patterns: terms.map((t) => ({
    re: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i'),
    weight: t.includes(' ') ? 2.5 : 1,
  })),
}));

export function categorize(title = '', description = '', sourceCategory = '') {
  // A category the source actually gave us beats anything inferred from text.
  const given = String(sourceCategory || '').trim().toLowerCase();
  if (CATEGORIES.includes(given)) {
    return { category: given, method: 'source', score: 1 };
  }

  const text = `${title} ${description}`.toLowerCase();
  if (!text.trim()) return { category: 'other', method: 'empty', score: 0 };

  const scores = new Map();
  for (const { category, patterns } of COMPILED) {
    let score = 0;
    for (const p of patterns) if (p.re.test(text)) score += p.weight;
    if (score) scores.set(category, score);
  }

  for (const b of COMPILED_BRANDS) {
    if (b.re.test(text)) {
      scores.set(b.category, (scores.get(b.category) ?? 0) + BRAND_WEIGHT);
    }
  }

  let best = { category: 'other', score: 0 };
  for (const [category, score] of scores) {
    if (score > best.score) best = { category, score };
  }

  return best.score > 0
    ? { category: best.category, method: 'keyword', score: best.score }
    : { category: 'other', method: 'unmatched', score: 0 };
}
