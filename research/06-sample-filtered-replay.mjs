// Research: for the 40 test-set listings, compare confidence and value using
// (a) production's stored comps, unfiltered, and (b) the same eBay results
// filtered to the listing's identity — a preview of the new pipeline's comps.
// Filtering can't fix a bad query; the second eBay sample (new queries) will.
import { readFileSync, writeFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';
import { confidence, conditionSpread } from './lib/confidence.mjs';
import { ACTIVE_TO_REALIZED, RETAIL_ANCHOR_WEIGHT, ACTIVE_ANCHOR_WEIGHT } from '../worker/src/config.js';

const DIR = new URL('./ebay-sample-2026-09-15/', import.meta.url);
const results = new Map(JSON.parse(readFileSync(new URL('results.json', DIR), 'utf8')).map((r) => [r.id, r]));
const testset = JSON.parse(readFileSync(new URL('testset.json', DIR), 'utf8'));
const PURITY = { 'brand+code': 0.3, code: 0.3, 'brand+noun': 0.25, brand: 0.5, noun: 0.2, none: 0.1 };

const q = (xs, p) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  return a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i - Math.floor(i));
};
// Production's anchor: blend of new median and discounted used median.
const anchor = (usedMed, newMed) =>
  usedMed != null && newMed != null ? newMed * RETAIL_ANCHOR_WEIGHT + usedMed * ACTIVE_TO_REALIZED * ACTIVE_ANCHOR_WEIGHT
  : usedMed != null ? usedMed * ACTIVE_TO_REALIZED : newMed;

const out = [];
for (const t of testset) {
  if (t.comp_source === 'local') continue;
  const id = identity(t.title);
  if (['none', 'noun'].includes(id.strength)) { out.push({ n: t.n, title: t.title, strength: id.strength, status: 'too vague' }); continue; }
  const cond = conditionSpread(t.condition);

  const stored = { n: t.comps ?? 0, p25: t.used_p25, p75: t.used_p75, median: t.ebay_used_median ?? t.ebay_new_median, newMedian: t.ebay_used_median != null ? t.ebay_new_median : null, source: 'ebay', filtered: false, purity: PURITY[id.strength] };
  const a = confidence({ strength: id.strength, comps: stored, band: t.condition });
  const aValue = anchor(t.ebay_used_median, t.ebay_new_median);

  const kept = results.get(t.n).items.filter((x) => judgeResult(x.title, id).relevant === true);
  const used = kept.filter((x) => x.conditionId === '3000').map((x) => x.price);
  const neu = kept.filter((x) => x.conditionId === '1000').map((x) => x.price);
  const filtered = used.length || neu.length
    ? { n: used.length, p25: q(used, 0.25), p75: q(used, 0.75), median: q(used, 0.5) ?? q(neu, 0.5), newMedian: used.length ? q(neu, 0.5) : null, source: 'ebay', filtered: true }
    : null;
  const b = filtered ? confidence({ strength: id.strength, comps: filtered, band: t.condition }) : null;
  const bValue = filtered ? anchor(q(used, 0.5), q(neu, 0.5)) : null;

  out.push({
    n: t.n, title: t.title, ask: t.ask, strength: id.strength, status: 'priced',
    stored: { value: aValue && aValue * cond.mean, confidence: a.confidence, sigma: a.sigma, comps: stored.n },
    filtered: filtered && { value: bValue * cond.mean, confidence: b.confidence, sigma: b.sigma, comps: filtered.n, kept: kept.length },
  });
}
writeFileSync(new URL('./out/06-sample-filtered-replay.json', import.meta.url), JSON.stringify(out, null, 1));

const $ = (v) => (v == null ? '    —' : `$${Math.round(v)}`.padStart(5));
const pc = (v) => (v == null ? '  —' : `${Math.round(v * 100)}%`.padStart(4));
console.log('  #  strength    ask   value stored→filtered   conf stored→filtered   used comps   title');
for (const x of out.filter((x) => x.status === 'priced')) {
  console.log(
    String(x.n).padStart(3), x.strength.padEnd(10), $(x.ask), `  ${$(x.stored.value)} → ${$(x.filtered?.value)}`,
    `         ${pc(x.stored.confidence)} → ${pc(x.filtered?.confidence)}`, `       ${String(x.stored.comps).padStart(2)} → ${String(x.filtered?.comps ?? 0).padStart(2)}`, '  ', x.title.slice(0, 40)
  );
}
const both = out.filter((x) => x.status === 'priced' && x.filtered);
const med = (f) => q(both.map(f), 0.5);
console.log(`\npriced ${out.filter((x) => x.status === 'priced').length}, too vague ${out.filter((x) => x.status === 'too vague').length}, filtered comps available ${both.length}`);
console.log(`median confidence: stored ${pc(med((x) => x.stored.confidence))} → filtered ${pc(med((x) => x.filtered.confidence))}`);
console.log(`median value change: ${pc(med((x) => (x.filtered.value - x.stored.value) / x.stored.value))}`);
