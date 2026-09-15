// Whole vehicles are refused at ingest (Jordan's rule): they need titles and
// registration, sell on a different market, and eBay prices them against toys,
// models and parts — "1972 Chevrolet Nova" came back at $13. Vehicle *parts*
// are ordinary flips and stay: rims, a car battery, a mini bike engine.
//
// Titles only say "vehicle" in combination, so no single word decides:
//   - a vehicle type that only means a vehicle ("motorcycle", "school bus"), or
//   - a year next to a make that only builds vehicles ("1992 Dodge"), or
//   - a make that also builds other things (Honda generators, Yamaha pianos)
//     plus a word that makes it the vehicle ("2019 Honda Grom motorcycle"), or
//   - paperwork only a vehicle has ("clean title", "salvage", "VIN", mileage).
// Any part or fitment wording ("rims", "for 2015 Civic") keeps the listing.
// When unsure it keeps: a stray vehicle still faces the $1,000 cap and the
// confidence gate, while a wrongly refused listing is gone without a trace.

const VEHICLE_TYPES = [
  'motorcycle', 'motorbike', 'dirt bike', 'dirtbike', 'pit bike', 'moped', 'atv', 'utv',
  'quad', 'side by side', 'golf cart', 'go kart', 'go-kart', 'motorhome', 'motor home', 'rv',
  'camper', 'travel trailer', 'fifth wheel', '5th wheel', 'school bus', 'box truck',
  'pickup truck', 'sedan', 'coupe', 'hatchback', 'minivan', 'jet ski', 'jetski', 'waverunner',
  'sea-doo', 'seadoo', 'seadoos', 'trailer home', 'mobile home',
];

// Makes whose name on a listing means a road vehicle.
const VEHICLE_ONLY_MAKES = [
  'acura', 'audi', 'buick', 'cadillac', 'chevrolet', 'chevy', 'chrysler', 'dodge', 'ferrari',
  'fiat', 'ford', 'gmc', 'hummer', 'hyundai', 'infiniti', 'jaguar', 'jeep', 'kia', 'lexus',
  'lincoln', 'mazda', 'mercedes', 'mercedes-benz', 'mini cooper', 'mitsubishi', 'nissan',
  'oldsmobile', 'pontiac', 'porsche', 'ram', 'saturn', 'scion', 'subaru', 'tesla', 'toyota',
  'volkswagen', 'vw', 'volvo', 'harley', 'harley-davidson', 'ducati', 'vespa', 'triumph',
];

// Makes that also sell generators, pianos, outboards, lawn gear or bicycles.
const SHARED_MAKES = ['honda', 'yamaha', 'suzuki', 'kawasaki', 'bmw', 'polaris', 'ktm', 'can-am'];

// Words that turn a shared make into the vehicle.
const VEHICLE_CONTEXT = [
  'motorcycle', 'motorbike', 'bike', 'scooter', 'atv', 'utv', 'dirt', 'street', 'cc', 'miles',
  'mileage', 'title', 'registered', 'tags', 'sedan', 'coupe', 'civic', 'accord', 'crv', 'cr-v',
  'odyssey', 'pilot', 'grom', 'ruckus', 'rebel', 'ninja', 'gsxr', 'r6', 'r1', 'rzr', 'raptor',
];

const PAPERWORK = [
  'clean title', 'salvage title', 'salvage', 'rebuilt title', 'pink slip', 'vin', 'smog',
  'odometer', 'registration', 'registered', 'current tags',
];

// Part or fitment wording: the listing is something for a vehicle.
const PART_WORDS = [
  'rim', 'rims', 'wheel', 'wheels', 'tire', 'tires', 'battery', 'headlight', 'headlights',
  'taillight', 'taillights', 'bumper', 'grille', 'grill', 'hood', 'fender', 'door', 'doors',
  'mirror', 'seat', 'seats', 'engine', 'motor', 'transmission', 'exhaust', 'muffler',
  'radiator', 'alternator', 'starter', 'part', 'parts', 'kit', 'cover', 'rack', 'hitch',
  'mat', 'mats', 'stereo', 'radio', 'speaker', 'speakers', 'subwoofer', 'amp', 'charger',
  'key', 'keys', 'fob', 'fobs', 'remote', 'manual', 'diecast', 'die-cast', 'toy',
  'lego', 'hot wheels', 'scale', 'sign', 'poster', 'jacket', 'shirt', 'hat', 'helmet',
  'lift', 'jack', 'cap', 'decal', 'emblem', 'badge', 'light', 'lights', 'bed liner', 'liner',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (list) => new RegExp(`(^|[^a-z0-9])(${list.map(esc).join('|')})(?=$|[^a-z0-9])`, 'i');

const TYPE_RE = phrase(VEHICLE_TYPES);
const ONLY_MAKE_RE = phrase(VEHICLE_ONLY_MAKES);
const SHARED_MAKE_RE = phrase(SHARED_MAKES);
const CONTEXT_RE = phrase(VEHICLE_CONTEXT);
const PAPERWORK_RE = phrase(PAPERWORK);
const PART_RE = phrase(PART_WORDS);
const YEAR_RE = /(^|[^0-9])(19[5-9]\d|20[0-2]\d)(?=$|[^0-9])/;
// "for 2015 civic", "fits chevy": the listing is the thing that fits. Only a
// year or a make counts after "for" — "trailer home for sale" is not a fitment.
const FITMENT_RE = new RegExp(
  `\\b(for|fits|fit)\\s+(a\\s+|an\\s+|the\\s+|my\\s+)?((19|20)\\d{2}|${[...VEHICLE_ONLY_MAKES, ...SHARED_MAKES].map(esc).join('|')})\\b`,
  'i'
);
const MILEAGE_RE = /\b\d{1,3}(,\d{3}|k)\s*(miles|mi)\b/i;

export function vehicleReason(title = '', category = '') {
  const text = ` ${String(title).toLowerCase()} `;
  const cat = String(category ?? '').toLowerCase();

  if (PART_RE.test(text) || FITMENT_RE.test(text)) return null;

  // The site said so itself (Facebook's detail page names the category).
  if (/\bvehicles?\b|\bcars?\s*(&|and)\s*trucks?\b|\bmotorcycles?\b|\bboats?\b|\brvs?\b/.test(cat)) {
    return 'vehicle category';
  }
  if (TYPE_RE.test(text)) return 'vehicle type';
  if (PAPERWORK_RE.test(text) || MILEAGE_RE.test(text)) return 'vehicle paperwork';
  if (YEAR_RE.test(text) && ONLY_MAKE_RE.test(text)) return 'year and vehicle make';
  if (SHARED_MAKE_RE.test(text) && CONTEXT_RE.test(text) && (YEAR_RE.test(text) || /\b\d{2,4}\s*cc\b/.test(text))) {
    return 'make with vehicle context';
  }
  return null;
}
