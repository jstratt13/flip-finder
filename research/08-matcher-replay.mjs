// Matcher v2 (production) vs v3 (identity-based) over every stored listing.
// What changes: too-vague calls, match scores, how listings group into
// products, and how many products would need a fresh eBay lookup.
//
// Needs out/match-v2.mjs, the v2 matcher with its config import repointed:
//   git show 046dff1:worker/src/match.js | sed "s#from './config.js'#from '../../worker/src/config.js'#" > out/match-v2.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { matchProduct as v2 } from './out/match-v2.mjs';
import { matchProduct as v3 } from '../worker/src/match.js';
import { isTooVague } from '../worker/src/config.js';

const rows = JSON.parse(readFileSync(new URL('./out/stored-listings.json', import.meta.url)))[0].results;
const tally = (xs, f) => xs.reduce((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {});

const out = rows.map((r) => {
  const a = v2(r.title, r.category ?? '');
  const b = v3(r.title, r.category ?? '');
  return {
    id: r.id, title: r.title, price: r.price,
    old_key: a?.product_key ?? null, new_key: b?.product_key ?? null,
    old_method: a?.method ?? 'none', new_method: b?.method ?? 'none',
    old_score: a?.match_score ?? null, new_score: b?.match_score ?? null,
    old_vague: !a || isTooVague(a.match_score), new_vague: !b || isTooVague(b.match_score),
    had_comps: r.active_median != null || r.retail_price != null,
  };
});

console.log(`listings ${out.length}`);
console.log('method v2 → v3:', JSON.stringify(tally(out, (x) => `${x.old_method} → ${x.new_method}`), null, 0));
const vague = tally(out, (x) => `${x.old_vague ? 'vague' : 'priced'} → ${x.new_vague ? 'vague' : 'priced'}`);
console.log('too vague v2 → v3:', JSON.stringify(vague));
console.log(`key changed: ${out.filter((x) => x.old_key !== x.new_key).length}`);

// Grouping: products that split (one v2 key → several v3 keys) and merged
// (several v2 keys → one v3 key). Merges are where a wrong key shares comps.
const groups = (from, to) => {
  const m = new Map();
  for (const x of out) if (x[from]) m.set(x[from], new Set([...(m.get(x[from]) ?? []), x[to]]));
  return [...m].filter(([, s]) => s.size > 1);
};
const splits = groups('old_key', 'new_key');
const merges = groups('new_key', 'old_key');
const ebayKeys = (k) => new Set(out.filter((x) => !x[k === 'new_key' ? 'new_vague' : 'old_vague'] && x[k] && !x[k].startsWith('local:')).map((x) => x[k]));
const oldKeys = ebayKeys('old_key');
const newKeys = ebayKeys('new_key');
const needLookup = [...newKeys].filter((k) => !oldKeys.has(k));
console.log(`distinct products: v2 ${new Set(out.map((x) => x.old_key)).size}, v3 ${new Set(out.map((x) => x.new_key)).size}`);
console.log(`eBay-priced products: v2 ${oldKeys.size}, v3 ${newKeys.size}; v3 keys needing a new eBay lookup: ${needLookup.length}`);
console.log(`local pools touched: ${new Set(out.filter((x) => x.old_key !== x.new_key).flatMap((x) => [x.old_key, x.new_key]).filter((k) => k?.startsWith('local:'))).size}`);
console.log(`splits ${splits.length}, merges ${merges.length}`);

const show = (label, xs, f) => {
  console.log(`\n${label} (${xs.length})`);
  for (const x of xs) console.log('  ' + f(x));
};
const line = (x) => `${x.title.slice(0, 52).padEnd(52)} | ${x.old_method} ${x.old_key?.slice(0, 34)} → ${x.new_method} ${x.new_key?.slice(0, 34)}`;
show('rescued: v2 too vague, v3 priced', out.filter((x) => x.old_vague && !x.new_vague), line);
show('demoted: v2 priced, v3 too vague', out.filter((x) => !x.old_vague && x.new_vague), line);
show('score changed, both priced', out.filter((x) => !x.old_vague && !x.new_vague && x.old_score !== x.new_score), line);
show('merged into one v3 key', merges, ([k, s]) => `${k}  ←  ${[...s].join('  |  ')}`);

writeFileSync(new URL('./out/08-matcher-replay.json', import.meta.url), JSON.stringify({ vague, splits: splits.length, merges: merges.map(([k, s]) => [k, [...s]]), needLookup, rows: out }, null, 2));
