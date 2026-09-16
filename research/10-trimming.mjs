// Outlier trimming for comps: today's 10th–90th-percentile band vs dropping
// exactly one price at each end (Jordan's proposal, 2026-09-15).
//
// The median barely moves under either — that's what a median is for. What
// changes is the SPREAD (p25/p75), and the spread is an input to confidence v2:
// a narrower spread means a higher P(within 25%), so trimming harder makes the
// model more confident whether or not it is more right.
import { readFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';
import { percentile, summarize as current } from '../worker/src/stats.js';
import { confidence } from './lib/confidence.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const s2 = read('./ebay-sample-2026-09-16/results.json');
const testset = read('./ebay-sample-2026-09-15/testset.json');
const titleOf = new Map(testset.map((t) => [t.n, t.title]));

// Drop one price from each end, then summarise what's left.
function dropEnds(prices) {
  const sorted = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (!sorted.length) return { median: null, p25: null, p75: null, n: 0 };
  const use = sorted.length >= 3 ? sorted.slice(1, -1) : sorted;
  return { median: percentile(use, 0.5), p25: percentile(use, 0.25), p75: percentile(use, 0.75), n: sorted.length };
}

// C: today's band, but always at least one price off each end once there are 5.
function bandPlusEnds(prices) {
  const sorted = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (sorted.length < 5) return current(prices);
  const cut = Math.max(1, Math.floor(sorted.length * 0.1));
  const use = sorted.slice(cut, -cut);
  return { median: percentile(use, 0.5), p25: percentile(use, 0.25), p75: percentile(use, 0.75), n: sorted.length };
}

const fmt = (v) => (v == null ? '—' : v.toFixed(0));
const rows = [];
for (const q of s2) {
  const title = titleOf.get(q.id);
  const id = identity(title);
  const kept = q.items.filter((i) => judgeResult(i.title, id).relevant !== false);
  const used = kept.filter((i) => i.conditionId === '3000').map((i) => i.price);
  if (!used.length) continue;
  const a = current(used);
  const b = dropEnds(used);
  const width = (s) => (s.p25 && s.p75 ? (s.p75 - s.p25) / s.median : null);
  const c = bandPlusEnds(used);
  rows.push({ id, title, n: used.length, a, b, c, wa: width(a), wb: width(b), wc: width(c) });
}

console.log('used comps per product: today (10–90% band) vs drop-one-each-end\n');
console.log('  n   median A → B      IQR/median A → B    listing');
for (const r of rows.sort((x, y) => x.n - y.n)) {
  const dm = r.a.median && r.b.median ? ((r.b.median - r.a.median) / r.a.median) * 100 : 0;
  console.log(
    `${String(r.n).padStart(3)}   ${fmt(r.a.median).padStart(5)} → ${fmt(r.b.median).padEnd(6)}${dm ? `(${dm > 0 ? '+' : ''}${dm.toFixed(0)}%)`.padEnd(8) : ''.padEnd(8)}` +
    `${r.wa == null ? '  —  ' : (r.wa * 100).toFixed(0).padStart(4) + '%'} → ${r.wb == null ? '  —  ' : (r.wb * 100).toFixed(0).padStart(4) + '%'}      ${r.title.slice(0, 40)}`
  );
}

const moved = rows.filter((r) => r.a.median !== r.b.median);
const narrower = rows.filter((r) => r.wa != null && r.wb != null && r.wb < r.wa);
console.log(`\nmedian changed on ${moved.length}/${rows.length} products; spread narrowed on ${narrower.length}`);
const medPct = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
console.log(
  `median IQR/median: today ${((medPct(rows.map((r) => r.wa).filter(Boolean)) ?? 0) * 100).toFixed(0)}%,` +
  ` drop-ends ${((medPct(rows.map((r) => r.wb).filter(Boolean)) ?? 0) * 100).toFixed(0)}%,` +
  ` band+ends ${((medPct(rows.map((r) => r.wc).filter(Boolean)) ?? 0) * 100).toFixed(0)}%`
);
console.log(`band+ends moves the median on ${rows.filter((r) => r.a.median !== r.c.median).length}/${rows.length} products`);

// What that does to confidence v2, holding everything else equal.
console.log('\nconfidence v2 with each spread (condition unknown, filtered comps):');
for (const r of rows.filter((x) => x.a.median).sort((x, y) => x.n - y.n)) {
  const c = (s) =>
    confidence({
      strength: r.id.strength,
      band: 'unknown',
      comps: { n: s.n, p25: s.p25, p75: s.p75, median: s.median, newMedian: null, source: 'ebay', filtered: true, purity: 0.55 },
    }).confidence;
  const ca = c(r.a), cb = c(r.b), cc = c(r.c);
  console.log(`  n ${String(r.n).padStart(3)}  today ${(ca * 100).toFixed(0).padStart(3)}% | drop-ends ${(cb * 100).toFixed(0).padStart(3)}% | band+ends ${(cc * 100).toFixed(0).padStart(3)}%   ${r.title.slice(0, 40)}`);
}
