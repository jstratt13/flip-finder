// Research: production's eBay query vs the identity-first query, for every stored listing.
import { readFileSync, writeFileSync } from 'node:fs';
import { identity } from './lib/identity.mjs';
import { matchProduct } from '../worker/src/match.js';
import { isTooVague } from '../worker/src/config.js';

const rows = JSON.parse(readFileSync(new URL('./out/stored-listings.json', import.meta.url), 'utf8'))[0].results;
const out = rows.map((r) => {
  const m = matchProduct(r.title, r.category ?? '');
  const id = identity(r.title);
  return { id: r.id, title: r.title, old_query: m?.query ?? '', old_method: m?.method ?? 'none', old_vague: isTooVague(m?.match_score), new_query: id.query, strength: id.strength, id };
});
writeFileSync(new URL('./out/04-query-building.json', import.meta.url), JSON.stringify(out, null, 1));

const tally = (f) => out.reduce((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {});
const priceable = (s) => ['brand+code', 'code'].includes(s);
console.log('listings', out.length);
console.log('new identity strength:', JSON.stringify(tally((x) => x.strength)));
console.log('old method:', JSON.stringify(tally((x) => x.old_method)));
console.log('\nold vague vs new strength:', JSON.stringify(tally((x) => `${x.old_vague ? 'old-vague' : 'old-priced'} → ${x.strength}`)));
const shorter = out.filter((x) => x.new_query && x.new_query.split(' ').length < x.old_query.split(' ').length).length;
console.log(`\nnew query shorter than old: ${shorter}; identical: ${out.filter((x) => x.new_query === x.old_query).length}`);

const show = (label, xs) => {
  console.log(`\n${label} (${xs.length})`);
  for (const x of xs.slice(0, 12)) console.log(`  ${x.title.slice(0, 44).padEnd(44)} | old: ${x.old_query.slice(0, 32).padEnd(32)} | new: ${x.new_query}`);
};
show('rescued: old too vague, new has a model code or generation', out.filter((x) => x.old_vague && priceable(x.strength)));
show('demoted: old priced, new finds no code or generation', out.filter((x) => !x.old_vague && !priceable(x.strength)));
show('changed queries on code-level listings', out.filter((x) => !x.old_vague && priceable(x.strength) && x.new_query !== x.old_query));
