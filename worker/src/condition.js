import { CONDITION_BANDS } from './config.js';

// Two kinds of signal, handled differently.
//
// 'grade' is a claim about overall condition. Several can match at once
// ("barely used" also contains "used"), so the most specific claim wins —
// otherwise every qualified phrase collapses into the generic band.
//
// 'damage' is a concrete defect. It caps the result regardless of how
// glowing the grade language is: "like new but the screen is cracked" is fair.
const SIGNALS = [
  { band: 'parts', type: 'damage', weight: 0.95, specificity: 3, patterns: [
    /\bfor parts\b/i, /\bparts only\b/i, /\bnot working\b/i, /\bdoesn'?t work\b/i,
    /\bbroken\b/i, /\bdead\b/i, /\bas[- ]is\b/i, /\bsalvage\b/i, /\bneeds? repair\b/i,
    /\bneeds? reupholster/i, /\bbroken frame\b/i, /\bmold(y|ing)?\b/i, /\bmildew\b/i,
  ]},
  { band: 'fair', type: 'damage', weight: 0.8, specificity: 3, patterns: [
    // Group the suffix: /cracked?/ would mean "cracke" + optional "d",
    // which silently fails to match the bare "crack".
    /\bcrack(ed|s)?\b/i, /\bchip(ped|s)?\b/i, /\bdent(ed|s)?\b/i, /\bstain(ed|s)?\b/i,
    /\btorn\b/i, /\bmissing\b/i, /\bworn\b/i, /\bfaded\b/i,
    // Soft goods and furniture carry their own damage vocabulary entirely.
    /\bwater damage\b/i, /\bsag(ging|s)?\b/i, /\brip(ped)?\b/i, /\bpeel(ing)?\b/i,
    /\bscuff(ed|s)?\b/i, /\bwobbl(y|es)\b/i, /\brust(ed|y)?\b/i, /\bpet damage\b/i,
    /\bpet hair\b/i, /\bodor\b/i, /\bsmoke damage\b/i, /\bdiscolou?red\b/i,
    // Unqualified scratches are damage; "minor scratches" is handled as a grade
    // claim below, so exclude the qualifiers here rather than let damage cap it.
    /(?<!\b(?:minor|light|few|small|slight|no)\s)\bscratch(ed|es)?\b/i,
  ]},
  { band: 'fair', type: 'grade', weight: 0.75, specificity: 3, patterns: [
    /\bheavily used\b/i, /\bwell used\b/i, /\bfair condition\b/i, /\brough shape\b/i,
  ]},
  { band: 'good', type: 'grade', weight: 0.7, specificity: 2, patterns: [
    /\bgood condition\b/i, /\bgently used\b/i, /\bminor wear\b/i, /\bsome wear\b/i,
    /\bnormal wear\b/i, /\bworks (great|well|fine|perfectly)\b/i, /\bpre[- ]owned\b/i,
    /\b(minor|light|few|small|slight) scratch(es)?\b/i,
    // In soft goods these are the seller's condition claim, and they carry real
    // money — a smoke-free sofa is worth materially more than an unqualified one.
    /\bsmoke[- ]free\b/i, /\bpet[- ]free\b/i, /\bno pets\b/i, /\bnon[- ]smoking\b/i,
    /\bstructurally sound\b/i,
  ]},
  // Deliberately lowest specificity: "used" appears inside many stronger phrases.
  { band: 'good', type: 'grade', weight: 0.55, specificity: 1, patterns: [/\bused\b/i] },
  { band: 'like_new', type: 'grade', weight: 0.85, specificity: 3, patterns: [
    /\blike new\b/i, /\bmint\b/i, /\bbarely used\b/i, /\bhardly used\b/i,
    /\bexcellent condition\b/i, /\bopen box\b/i, /\bused once\b/i, /\bpristine\b/i,
    /\bno scratches\b/i, /\bflawless\b/i,
  ]},
  { band: 'new', type: 'grade', weight: 0.9, specificity: 4, patterns: [
    /\bbrand new\b/i, /\bnew in box\b/i, /\bnib\b/i, /\bbnib\b/i, /\bsealed\b/i,
    /\bnever used\b/i, /\bnever opened\b/i, /\bunopened\b/i, /\bnew with tags\b/i,
  ]},
];

const ORDER = ['parts', 'fair', 'good', 'like_new', 'new'];
const worseOf = (a, b) => (ORDER.indexOf(a) < ORDER.indexOf(b) ? a : b);

// "subs with brand new amp" describes the amp, not the subs. A grade claim
// hanging off an accessory says nothing about the item being sold, and taking
// it at face value grades a used bundle as new.
const ACCESSORY_SCOPE = /\b(?:with|w\/|includes?|including|plus|comes with|and an?)\s+(?:\w+\s+){0,2}$/i;

function isAccessoryScoped(text, matchIndex) {
  return ACCESSORY_SCOPE.test(text.slice(Math.max(0, matchIndex - 40), matchIndex));
}

// Structured condition fields, when a source provides one.
const RAW_MAP = {
  new: 'new',
  'new (other)': 'new',
  'new with tags': 'new',
  'open box': 'like_new',
  'like new': 'like_new',
  'used - like new': 'like_new',
  excellent: 'like_new',
  good: 'good',
  'used - good': 'good',
  used: 'good',
  fair: 'fair',
  'used - fair': 'fair',
  poor: 'fair',
  'for parts': 'parts',
  'for parts or not working': 'parts',
  salvage: 'parts',
};

export function assessCondition({ title = '', description = '', condition_raw = '' }) {
  const signals = [];

  const rawKey = String(condition_raw || '').trim().toLowerCase();
  const rawBand = RAW_MAP[rawKey];
  if (rawBand) {
    // A structured field from the source outranks anything inferred from prose.
    signals.push({ band: rawBand, type: 'grade', weight: 0.9, specificity: 5, via: `field:${rawKey}` });
  }

  const text = `${title}\n${description}`;
  for (const group of SIGNALS) {
    for (const re of group.patterns) {
      const m = text.match(re);
      if (!m) continue;

      // Damage still counts wherever it appears — a defect in an included part
      // is a defect. Only optimistic grade claims get scope-checked.
      if (group.type === 'grade' && isAccessoryScoped(text, m.index)) continue;

      signals.push({
        band: group.band,
        type: group.type,
        weight: group.weight,
        specificity: group.specificity,
        via: `text:${m[0].toLowerCase()}`,
      });
      break;
    }
  }

  if (!signals.length) {
    return {
      band: 'unknown',
      multiplier: CONDITION_BANDS.unknown.multiplier,
      confidence: 0.2,
      signals: [],
    };
  }

  const grades = signals.filter((s) => s.type === 'grade');
  const damages = signals.filter((s) => s.type === 'damage');

  // Among competing grade claims the most specific one is the real claim.
  const claimed = grades.length
    ? grades.reduce((acc, s) =>
        s.specificity > acc.specificity ? s
        : s.specificity === acc.specificity ? (worseOf(s.band, acc.band) === s.band ? s : acc)
        : acc
      )
    : null;

  const worstDamage = damages.length
    ? damages.reduce((acc, s) => (worseOf(s.band, acc.band) === s.band ? s : acc))
    : null;

  const band = claimed && worstDamage ? worseOf(claimed.band, worstDamage.band)
    : claimed ? claimed.band
    : worstDamage.band;

  const deciding = [claimed, worstDamage].filter((s) => s && s.band === band);
  const weight = Math.max(...deciding.map((s) => s.weight));
  const agreeing = signals.filter((s) => s.band === band).length;
  const confidence = Math.min(0.95, weight * Math.min(1, 0.6 + agreeing * 0.2));

  return {
    band,
    multiplier: CONDITION_BANDS[band].multiplier,
    confidence,
    signals,
  };
}
