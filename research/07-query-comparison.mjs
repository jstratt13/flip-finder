// Research: production's query (sample 1) vs the identity-first query (sample 2)
// for the same listings. Same filter and page size; results judged against the
// listing's identity either way, then priced and scored by the draft model.
import { readFileSync, writeFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';
import { confidence, conditionSpread } from './lib/confidence.mjs';
import { ACTIVE_TO_REALIZED, RETAIL_ANCHOR_WEIGHT, ACTIVE_ANCHOR_WEIGHT } from '../worker/src/config.js';

const load = (dir, f) => JSON.parse(readFileSync(new URL(`./${dir}/${f}`, import.meta.url), 'utf8'));
const oldRes = new Map(load('ebay-sample-2026-09-15', 'results.json').map((r) => [r.id, r]));
const newRes = new Map(load('ebay-sample-2026-09-16', 'results.json').map((r) => [r.id, r]));
const testset = new Map(load('ebay-sample-2026-09-15', 'testset.json').map((t) => [t.n, t]));

const q = (xs, p) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  return a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i - Math.floor(i));
};
const anchor = (usedMed, newMed) =>
  usedMed != null && newMed != null ? newMed * RETAIL_ANCHOR_WEIGHT + usedMed * ACTIVE_TO_REALIZED * ACTIVE_ANCHOR_WEIGHT
  : usedMed != null ? usedMed * ACTIVE_TO_REALIZED : newMed;

function price(result, t, id) {
  const kept = result.items.filter((x) => judgeResult(x.title, id).relevant === true);
  const used = kept.filter((x) => x.conditionId === '3000').map((x) => x.price);
  const neu = kept.filter((x) => x.conditionId === '1000').map((x) => x.price);
  const share = result.items.length ? kept.length / result.items.length : 0;
  if (!used.length && !neu.length) return { query: result.q, results: result.items.length, kept: 0, share, used: 0 };
  const comps = { n: used.length, p25: q(used, 0.25), p75: q(used, 0.75), median: q(used, 0.5) ?? q(neu, 0.5), newMedian: used.length ? q(neu, 0.5) : null, source: 'ebay', filtered: true };
  const c = confidence({ strength: id.strength, comps, band: t.condition });
  return {
    query: result.q, results: result.items.length, kept: kept.length, share, used: used.length,
    value: anchor(q(used, 0.5), q(neu, 0.5)) * conditionSpread(t.condition).mean, confidence: c.confidence, pWithin: c.pWithin,
  };
}

const rows = [];
for (const [n, nr] of newRes) {
  const t = testset.get(n);
  const id = identity(t.title);
  rows.push({ n, title: t.title, strength: id.strength, before: price(oldRes.get(n), t, id), after: price(nr, t, id) });
}
rows.sort((a, b) => a.n - b.n);
writeFileSync(new URL('./out/07-query-comparison.json', import.meta.url), JSON.stringify(rows, null, 1));

const pc = (v) => (v == null ? '  —' : `${Math.round(v * 100)}%`.padStart(4));
const $ = (v) => (v == null ? '    —' : `$${Math.round(v)}`.padStart(5));
console.log('  #  strength    relevant results old→new   used comps   value old→new    confidence old→new   new query');
for (const r of rows) {
  const b = r.before, a = r.after;
  console.log(
    String(r.n).padStart(3), r.strength.padEnd(10), `${String(b.kept).padStart(3)} ${pc(b.share)} → ${String(a.kept).padStart(3)} ${pc(a.share)}`,
    `   ${String(b.used).padStart(2)}→${String(a.used).padStart(2)}`, `   ${$(b.value)}→${$(a.value)}`, `     ${pc(b.confidence)} → ${pc(a.confidence)}`, `    ${a.query}`
  );
}
const code = rows.filter((r) => ['brand+code', 'code'].includes(r.strength));
const other = rows.filter((r) => !['brand+code', 'code'].includes(r.strength));
for (const [label, set] of [['model code / generation', code], ['brand only', other]]) {
  const m = (f) => q(set.map(f).filter((v) => v != null), 0.5);
  console.log(`\n${label} (${set.length}):`);
  console.log(`  median relevant share     ${pc(m((r) => r.before.share))} → ${pc(m((r) => r.after.share))}`);
  console.log(`  median relevant used comps ${String(m((r) => r.before.used)).padStart(3)} → ${m((r) => r.after.used)}`);
  console.log(`  listings with no usable comps ${set.filter((r) => !r.before.used && !r.before.kept).length} → ${set.filter((r) => !r.after.used && !r.after.kept).length}`);
  console.log(`  median confidence (where priced) ${pc(m((r) => r.before.confidence))} → ${pc(m((r) => r.after.confidence))}`);
  console.log(`  confidence up / down / same: ${set.filter((r) => (r.after.confidence ?? 0) > (r.before.confidence ?? 0) + 0.02).length} / ${set.filter((r) => (r.after.confidence ?? 0) < (r.before.confidence ?? 0) - 0.02).length} / ${set.filter((r) => Math.abs((r.after.confidence ?? 0) - (r.before.confidence ?? 0)) <= 0.02).length}`);
}
