// Does the eBay category of a result tell us whether it's the listing's product,
// beyond what the title judge already sees? Every search returns a leaf
// category per result at no extra cost.
//
// Candidate rules, applied after the judge, to the results it kept:
//   A  parts/accessory category: drop a result whose category name says parts or
//      accessories ("3D Printer Parts", "Replacement Parts & Tools") unless the
//      listing itself names such a thing, or most kept results are in such
//      categories (the listing is a part: "LG 6870EC 9081C-2" → Washer & Dryer Parts).
//   B  stray category: drop a result whose category holds under MIN_SHARE of the
//      kept results, once there are enough kept results for a share to mean anything.
//
// Scored on the 160 hand-labelled results (02 tuning set, 03 held-out set, both
// from sample 1) and applied to sample 2 (identity queries, as production runs)
// for what it does to comp counts and medians.
import { readFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const s1 = read('./ebay-sample-2026-09-15/results.json');
const s2 = read('./ebay-sample-2026-09-16/results.json');
const testset = read('./ebay-sample-2026-09-15/testset.json');
const titleOf = new Map(testset.map((t) => [t.n, t.title]));

const PARTS_RE = /\b(parts?|accessor(y|ies)|replacement|cases?|covers?|skins?|decals?|stickers?|faceplates?|chargers?|batter(y|ies)|mounts?|stands?|bags|straps?|bands|lenses|filters|tools)\b/i;
const MIN_SHARE = 0.1;
const MIN_KEPT_FOR_SHARE = 10;
const PARTS_MAJORITY = 2 / 3;

// Per search: the judge's kept set and how it spreads across categories.
function categoryContext(items, id, listingTitle) {
  const kept = items.filter((i) => judgeResult(i.title, id).relevant !== false);
  const count = new Map();
  for (const i of kept) count.set(i.categoryIds?.[0], (count.get(i.categoryIds?.[0]) ?? 0) + 1);
  const partsKept = kept.filter((i) => PARTS_RE.test(i.categories?.[0] ?? '')).length;
  return {
    kept: kept.length,
    count,
    listingIsPart: PARTS_RE.test(listingTitle) || (kept.length > 0 && partsKept / kept.length >= PARTS_MAJORITY),
  };
}

function ruleDrops(item, ctx, rules) {
  const cat = item.categories?.[0] ?? '';
  if (rules.includes('A') && !ctx.listingIsPart && PARTS_RE.test(cat)) return 'A';
  if (rules.includes('B') && ctx.kept >= MIN_KEPT_FOR_SHARE && (ctx.count.get(item.categoryIds?.[0]) ?? 0) / ctx.kept < MIN_SHARE) return 'B';
  return null;
}

// Labels. 02: out/02-judge-labels.json, index-aligned with out/02-judge-spotcheck.json.
// 03: the same array as 03-holdout-score.mjs (misspelled-brand rows excluded there too).
const T = true, F = false, U = null;
const HOLDOUT = [
  F, T, F, F, T, F, U, F, F, T, T, F, F, F, F, T, F, F, F, F, F, F, F, F, T, T, F, F, F, F,
  T, F, T, F, F, F, F, T, F, T, T, U, T, T, T, T, T, T, T, F, F, U, F, F, T, T, F, T, F, F,
];
const HOLDOUT_TYPO = new Set([4, 25, 57]);
const labelled = [
  ...read('./out/02-judge-spotcheck.json').map((s, i) => ({ ...s, truth: read('./out/02-judge-labels.json').truth[i], set: 'tuning' })),
  ...read('./out/03-holdout.json').map((s, i) => ({ ...s, truth: HOLDOUT_TYPO.has(i) ? null : HOLDOUT[i], set: 'holdout' })),
].filter((x) => x.truth !== null);

const ctxCache = new Map();
function contextFor(sample, n) {
  const key = `${sample === s1 ? 1 : 2}|${n}`;
  if (!ctxCache.has(key)) {
    const q = sample.find((x) => x.id === n);
    ctxCache.set(key, { q, ctx: categoryContext(q.items, identity(titleOf.get(n)), titleOf.get(n)) });
  }
  return ctxCache.get(key);
}

function score(rules, set) {
  let tk = 0, fk = 0, td = 0, fd = 0;
  const changed = [];
  for (const x of labelled.filter((l) => !set || l.set === set)) {
    const { q, ctx } = contextFor(s1, x.n);
    const item = q.items.find((i) => i.title === x.result);
    const judged = judgeResult(x.result, identity(titleOf.get(x.n))).relevant !== false;
    const drop = judged ? ruleDrops(item, ctx, rules) : null;
    const kept = judged && !drop;
    if (drop) changed.push(`${x.truth ? 'WRONG' : 'right'} drop (${drop}) [${item.categories[0]}] ${x.result.slice(0, 80)}`);
    if (kept && x.truth) tk++; else if (kept) fk++; else if (!x.truth) td++; else fd++;
  }
  const n = tk + fk + td + fd;
  return { n, accuracy: (tk + td) / n, precision: tk / (tk + fk), recall: tk / (tk + fd), changed };
}

const pct = (v) => `${Math.round(v * 100)}%`;
for (const set of ['tuning', 'holdout', null]) {
  for (const rules of [[], ['A'], ['B'], ['A', 'B']]) {
    const r = score(rules, set);
    console.log(`${(set ?? 'all').padEnd(8)} judge${rules.map((x) => '+' + x).join('').padEnd(5)} n ${r.n} | accuracy ${pct(r.accuracy)} | keep precision ${pct(r.precision)} | recall ${pct(r.recall)}`);
  }
}
console.log('\nlabelled results the rules drop (all sets, A+B):');
for (const c of score(['A', 'B'], null).changed) console.log('  ' + c);

// Sample 2: effect on the comps production would build.
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
console.log('\nsample 2 (identity queries): used comps and median, judge → judge+A+B');
let totalDropped = 0;
for (const q of s2) {
  const title = titleOf.get(q.id);
  const { ctx } = contextFor(s2, q.id);
  const id = identity(title);
  const kept = q.items.filter((i) => judgeResult(i.title, id).relevant !== false);
  const after = kept.filter((i) => !ruleDrops(i, ctx, ['A', 'B']));
  const used = (xs) => xs.filter((i) => i.conditionId === '3000').map((i) => i.price);
  const dropped = kept.filter((i) => !after.includes(i));
  totalDropped += dropped.length;
  if (!dropped.length) continue;
  const m0 = median(used(kept)), m1 = median(used(after));
  console.log(`  #${q.id} ${title.slice(0, 38).padEnd(38)} kept ${kept.length}→${after.length} used n ${used(kept).length}→${used(after).length} median ${m0?.toFixed(0)}→${m1?.toFixed(0)}`);
  for (const d of dropped) console.log(`      − [${d.categories[0]}] ${d.title.slice(0, 70)} $${d.price}`);
}
console.log(`  dropped ${totalDropped} results across ${s2.length} searches`);

// Findings, 2026-09-15 (titles judged by Claude, not Jordan):
// - Labelled sets: B turns two kept-wrongly results into drops (all 90% → 92%);
//   A changes nothing there.
// - Sample 2, 32 results dropped. A drops 9: 8 are accessories or parts
//   (Bambu AMS, hotend, toolhead; PS5 motherboard, faceplates, travel case) and
//   1 is a real MOTOPOWER scanner filed under "Chargers & Jump Starters".
//   B drops 23, about 8 right (paddles for a table listing, sandals for heels,
//   Wave IV for a Wave) and 14 real products sellers filed oddly (iPhone 13 under
//   phone accessories, Seagate under PLC processors, G29 wheels, Dell monitor).
// - No used median moved by more than $2, except Bambu P1P ($250 → $260 on 2 → 1).
// Conclusion: B is a coin flip on the realistic queries; A is precise but rare.
