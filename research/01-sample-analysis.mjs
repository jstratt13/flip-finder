// Research: how relevant were eBay's results to the listing, and what does
// filtering them to the listing's identity do to the prices we'd compute?
import { readFileSync, writeFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';

const DIR = new URL('./ebay-sample-2026-09-15/', import.meta.url);
const results = JSON.parse(readFileSync(new URL('results.json', DIR), 'utf8'));
const testset = new Map(JSON.parse(readFileSync(new URL('testset.json', DIR), 'utf8')).map((i) => [i.n, i]));

const quantile = (xs, p) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  return a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i - Math.floor(i));
};
const summary = (items) => {
  const used = items.filter((x) => x.conditionId === '3000').map((x) => x.price);
  const neu = items.filter((x) => x.conditionId === '1000').map((x) => x.price);
  const med = quantile(used, 0.5);
  return {
    n: items.length, used_n: used.length, new_n: neu.length,
    used_median: med, new_median: quantile(neu, 0.5),
    spread: med ? (quantile(used, 0.75) - quantile(used, 0.25)) / 2 / med : null,
  };
};
const topCategory = (items) => {
  const c = {};
  for (const x of items) { const k = x.categories[0] ?? '?'; c[k] = (c[k] ?? 0) + 1; }
  const [name, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0] ?? ['—', 0];
  return { name, share: items.length ? n / items.length : 0 };
};

const rows = [];
const reasons = {};
for (const r of results) {
  const t = testset.get(r.id);
  const id = identity(t.title);
  const judged = r.items.map((x) => ({ ...x, ...judgeResult(x.title, id) }));
  for (const j of judged) reasons[j.why] = (reasons[j.why] ?? 0) + 1;
  const kept = judged.filter((j) => j.relevant);
  const checkable = judged.filter((j) => j.relevant !== null);
  const all = summary(r.items);
  const rel = summary(kept);
  rows.push({
    n: r.id, title: t.title, ask: t.ask, strength: id.strength, old_query: r.q, new_query: id.query,
    results: r.items.length, checkable: checkable.length, relevant: kept.length,
    relevant_share: checkable.length ? kept.length / checkable.length : null,
    all, rel,
    all_inverted: all.new_median != null && all.used_median != null && all.new_median < all.used_median,
    rel_inverted: rel.new_median != null && rel.used_median != null && rel.new_median < rel.used_median,
    category_all: topCategory(r.items), category_rel: topCategory(kept),
    dropped_examples: judged.filter((j) => j.relevant === false).slice(0, 4).map((j) => `${j.why}: ${j.title}`),
    kept_examples: kept.slice(0, 3).map((j) => j.title),
  });
}
writeFileSync(new URL('./out/01-sample-analysis.json', import.meta.url), JSON.stringify({ rows, reasons }, null, 1));

const pct = (x) => (x == null ? '  —' : `${Math.round(x * 100)}%`.padStart(4));
const $ = (x) => (x == null ? '    —' : `$${Math.round(x)}`.padStart(5));
console.log('why results were dropped:', JSON.stringify(reasons));
console.log('\n  #  strength    results relevant  used med all→rel   spread all→rel  inverted all→rel  top cat all→rel   title');
for (const x of rows.sort((a, b) => a.n - b.n)) {
  console.log(
    String(x.n).padStart(3), x.strength.padEnd(10), String(x.results).padStart(4), `${String(x.relevant).padStart(4)} ${pct(x.relevant_share)}`,
    `${$(x.all.used_median)}→${$(x.rel.used_median)}`, `  ${pct(x.all.spread)}→${pct(x.rel.spread)}`,
    `      ${x.all_inverted ? 'Y' : '-'}→${x.rel_inverted ? 'Y' : '-'}`,
    `        ${pct(x.category_all.share)}→${pct(x.category_rel.share)}`, '  ', x.title.slice(0, 40)
  );
}
const with_ = rows.filter((x) => x.checkable);
const med = (f) => quantile(with_.map(f).filter((v) => v != null), 0.5);
console.log(`\nqueries with something to check: ${with_.length}/40`);
console.log(`median relevant share: ${pct(med((x) => x.relevant_share))}`);
console.log(`median used-price spread: all ${pct(med((x) => x.all.spread))} → relevant ${pct(med((x) => x.rel.spread))}`);
console.log(`new-below-used inversions: all ${rows.filter((x) => x.all_inverted).length} → relevant ${rows.filter((x) => x.rel_inverted).length}`);
console.log(`median top-category share: all ${pct(med((x) => x.category_all.share))} → relevant ${pct(med((x) => x.category_rel.share))}`);
