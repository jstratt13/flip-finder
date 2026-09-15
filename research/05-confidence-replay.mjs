// Research: replay the draft confidence model over every stored listing and
// compare it with production's confidence and ranking.
//
// Limits, stated up front:
//  - Stored comps came from production's queries and were never filtered to the
//    listing's identity. The model charges extra doubt for that ("unfiltered"),
//    scaled by how pure eBay's results were in the sample for that kind of title.
//  - For the 40 test-set listings we also have eBay's raw results, so a second
//    replay filters them first — a preview of comps under the new pipeline.
//  - No ground truth yet: Jordan's labels will say which model is right.
import { readFileSync, writeFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';
import { confidence, WITHIN } from './lib/confidence.mjs';
import { scoreListing } from '../worker/src/score.js';
import { SCORING, CONDITION_BANDS, pickupCost } from '../worker/src/config.js';

const rows = JSON.parse(readFileSync(new URL('./out/stored-listings.json', import.meta.url), 'utf8'))[0].results;

// Median share of eBay results that were the listing's product, by title
// strength, from 01-sample-analysis. Production's unfiltered comps for code-level
// titles were mostly other products. Brand-only is capped at 0.5: the judge
// can't tell products apart there, so its measured purity is inflated.
const PURITY = { 'brand+code': 0.3, code: 0.3, 'brand+noun': 0.25, brand: 0.5, noun: 0.2, none: 0.1 };

const GATES = [0.3, 0.4, 0.5, 0.6];
const quantile = (xs, p) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  return a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i - Math.floor(i));
};

function evaluate(r, comps, strength) {
  const band = r.band ?? 'unknown';
  const c = confidence({ strength, comps, band });
  const multiplier = band === 'unknown' ? c.conditionMean : CONDITION_BANDS[band]?.multiplier ?? c.conditionMean;
  const compRow = comps && { retail_price: comps.newMedian, active_median: comps.median, n_active: comps.n, source: comps.source };
  const s = compRow
    ? scoreListing({
        listing: { id: r.id, title: r.title, price: r.price, category: r.category, distance_mi: r.distance_mi, acquisition_mode: r.acquisition_mode, inbound_ship: r.inbound_ship },
        comp: compRow,
        condition: { multiplier, confidence: 1 },
        match: { match_score: 1 },
      })
    : null;
  // If the comparables were the wrong product we'd most likely resell near what
  // we paid: the loss is the drive. Expected profit weighs both outcomes.
  const overhead = r.acquisition_mode === 'shipped' ? r.inbound_ship ?? 0 : pickupCost(r.distance_mi);
  const expected = s?.profit != null ? c.pRight * s.profit + (1 - c.pRight) * -overhead : null;
  return { ...c, profitIfRight: s?.profit ?? null, expected, roi: s?.roi ?? null, value: s?.anchor_value != null ? s.anchor_value * multiplier : null };
}

const replay = [];
for (const r of rows) {
  const id = identity(r.title);
  const vague = ['none', 'noun'].includes(id.strength) && r.comp_source !== 'local';
  const comps = r.active_median != null || r.retail_price != null
    ? {
        n: r.n_active ?? 0, p25: r.active_p25, p75: r.active_p75, median: r.active_median ?? r.retail_price,
        newMedian: r.active_median != null ? r.retail_price : null, source: r.comp_source ?? 'ebay',
        filtered: r.comp_source === 'local', purity: PURITY[id.strength] ?? 0.1,
      }
    : null;
  const next = vague || !comps ? null : evaluate(r, comps, id.strength);
  const oldRanks = r.score != null && r.profit >= SCORING.min_profit && r.roi >= SCORING.min_roi && r.confidence >= SCORING.min_confidence;
  replay.push({
    id: r.id, title: r.title, ask: r.price, strength: id.strength, band: r.band, comps: comps && { n: comps.n, median: comps.median },
    old: { confidence: r.confidence, profit: r.profit, ranks: oldRanks },
    next: next && { confidence: next.confidence, pRight: next.pRight, pWithin: next.pWithin, sigma: next.sigma, expected: next.expected, profitIfRight: next.profitIfRight, roi: next.roi },
    status: vague ? 'too vague' : !comps ? 'no comps' : 'priced',
    ranksAt: next ? Object.fromEntries(GATES.map((g) => [g, next.expected >= SCORING.min_profit && next.roi >= SCORING.min_roi && next.confidence >= g])) : {},
  });
}
writeFileSync(new URL('./out/05-confidence-replay.json', import.meta.url), JSON.stringify(replay, null, 1));

const priced = replay.filter((x) => x.status === 'priced');
console.log(`listings ${replay.length} | priced ${priced.length} | too vague ${replay.filter((x) => x.status === 'too vague').length} | no comps ${replay.filter((x) => x.status === 'no comps').length}`);
console.log(`WITHIN = ±${WITHIN * 100}%\n`);

const bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.01];
const hist = (xs) => bins.slice(0, -1).map((b, i) => xs.filter((v) => v >= b && v < bins[i + 1]).length);
const oldConf = priced.map((x) => x.old.confidence ?? 0);
const newConf = priced.map((x) => x.next.confidence);
console.log('confidence      ' + bins.slice(0, -1).map((b) => `${Math.round(b * 100)}%+`.padStart(5)).join(''));
console.log('old (unitless)  ' + hist(oldConf).map((n) => String(n).padStart(5)).join(''));
console.log('new P(±25%)     ' + hist(newConf).map((n) => String(n).padStart(5)).join(''));
console.log(`\nmedian new confidence by title strength:`);
for (const s of ['brand+code', 'code', 'brand+noun', 'brand']) {
  const xs = priced.filter((x) => x.strength === s);
  if (xs.length) console.log(`  ${s.padEnd(11)} n ${String(xs.length).padStart(3)}  P(right) ${Math.round(xs[0].next.pRight * 100)}%  P(±25% | right) median ${Math.round(quantile(xs.map((x) => x.next.pWithin), 0.5) * 100)}%  confidence median ${Math.round(quantile(xs.map((x) => x.next.confidence), 0.5) * 100)}%`);
}

console.log(`\nwould rank (expected profit ≥ $${SCORING.min_profit}, ROI ≥ ${SCORING.min_roi * 100}%):`);
console.log(`  production today (confidence ≥ ${SCORING.min_confidence}): ${replay.filter((x) => x.old.ranks).length}`);
for (const g of GATES) console.log(`  new, confidence ≥ ${g * 100}%: ${priced.filter((x) => x.ranksAt[g]).length}`);

const $ = (v) => (v == null ? '—' : `$${Math.round(v)}`);
const pc = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
console.log('\ntop 15 by expected profit among listings at confidence ≥ 40%:');
for (const x of priced.filter((x) => x.ranksAt[0.4]).sort((a, b) => b.next.expected - a.next.expected).slice(0, 15)) {
  console.log(`  ${$(x.next.expected).padStart(5)} exp  ${$(x.next.profitIfRight).padStart(5)} if right  conf ${pc(x.next.confidence).padStart(4)}  (right ${pc(x.next.pRight)}, ±25% ${pc(x.next.pWithin)})  ask ${$(x.ask).padStart(5)}  ${x.strength.padEnd(10)} ${x.title.slice(0, 44)}`);
}
console.log('\nin production\'s ranking today:');
for (const x of replay.filter((x) => x.old.ranks)) {
  console.log(`  old conf ${pc(x.old.confidence)} profit ${$(x.old.profit)} → new conf ${pc(x.next?.confidence)} expected ${$(x.next?.expected)} | ${x.strength} | ${x.title.slice(0, 60)}`);
}
