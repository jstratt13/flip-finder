// Does a narrower eBay query beat filtering the results afterwards?
//
// Three variants per product, one API call each, against the real Browse API:
//   A  what production sends today (identity.js query)
//   B  A plus negative keywords ("-case -charger -parts ...") — UNVERIFIED
//      syntax: if Browse treats a leading "-" as an ordinary keyword, B gets
//      WORSE, and that is exactly what this script is here to find out
//   C  A restricted to one eBay category, taken from where A's own relevant
//      results actually sat (no category map to maintain)
//
// Run from research/ with credentials from the worker's .dev.vars:
//   node --env-file=../worker/.dev.vars 11-query-variants.mjs
//
// Costs 3 calls per product against the 5,000/day allowance.
import { readFileSync } from 'node:fs';
import { identity, judgeResult } from './lib/identity.mjs';
import { getToken } from '../worker/src/ebay.js';
import { summarize } from '../worker/src/stats.js';

const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const EXCLUDE = ['case', 'charger', 'parts', 'cover', 'adapter', 'cable', 'mount', 'battery'];

const env = {
  EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID,
  EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET,
  CACHE: { get: async () => null, put: async () => {} },
};
if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
  console.error('No eBay credentials. Run with: node --env-file=../worker/.dev.vars 11-query-variants.mjs');
  process.exit(1);
}

const token = await getToken(env);

async function search(q, { categoryId } = {}) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '50');
  url.searchParams.set('filter', 'conditionIds:{1000|3000},buyingOptions:{FIXED_PRICE}');
  if (categoryId) url.searchParams.set('category_ids', categoryId);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 120)}`, items: [] };
  const body = await res.json();
  return {
    total: body.total ?? 0,
    items: (body.itemSummaries ?? []).map((it) => ({
      title: it.title,
      price: Number(it.price?.value) + Number(it.shippingOptions?.[0]?.shippingCost?.value ?? 0),
      conditionId: it.conditionId != null ? String(it.conditionId) : null,
      categoryId: it.categories?.[0]?.categoryId ?? null,
      categoryName: it.categories?.[0]?.categoryName ?? null,
    })),
  };
}

const score = (items, id) => {
  const kept = items.filter((i) => judgeResult(i.title, id).relevant !== false);
  const used = summarize(kept.filter((i) => i.conditionId === '3000').map((i) => i.price));
  return { n: items.length, relevant: kept.length, usedN: used.n, median: used.median, kept };
};

const modalCategory = (kept) => {
  const by = new Map();
  for (const i of kept) if (i.categoryId) by.set(i.categoryId, (by.get(i.categoryId) ?? 0) + 1);
  const best = [...by].sort((a, b) => b[1] - a[1])[0];
  return best ? { id: best[0], n: best[1], name: kept.find((i) => i.categoryId === best[0])?.categoryName } : null;
};

const rows = JSON.parse(readFileSync(new URL('./out/stored-listings.json', import.meta.url)))[0].results;
const pick = (needle) => rows.find((r) => r.title.toLowerCase().includes(needle));
const targets = (process.env.TARGETS ? process.env.TARGETS.split('|') : ['bambu', 'ps5 slim', 'fire tv', 'g29', 'polk audio r10', 'iphone 13 -', 'litter robot', 'sangean'])
  .map(pick)
  .filter(Boolean);

const fmt = (v) => (v == null ? '—' : `$${v.toFixed(0)}`);
for (const listing of targets) {
  const id = identity(listing.title);
  console.log(`\n${listing.title.slice(0, 60)}\n  query: "${id.query}"`);

  const a = await search(id.query);
  if (a.error) { console.log(`  A failed: ${a.error}`); continue; }
  const sa = score(a.items, id);
  console.log(`  A plain            results ${String(sa.n).padStart(2)}  relevant ${String(sa.relevant).padStart(2)}  used ${String(sa.usedN).padStart(2)}  median ${fmt(sa.median)}`);

  const b = await search(`${id.query} ${EXCLUDE.filter((w) => !id.allWords.includes(w)).map((w) => `-${w}`).join(' ')}`);
  if (b.error) console.log(`  B failed: ${b.error}`);
  else {
    const sb = score(b.items, id);
    console.log(`  B minus-keywords   results ${String(sb.n).padStart(2)}  relevant ${String(sb.relevant).padStart(2)}  used ${String(sb.usedN).padStart(2)}  median ${fmt(sb.median)}`);
  }

  const cat = modalCategory(sa.kept);
  if (!cat) { console.log('  C skipped: A found nothing relevant to take a category from'); continue; }
  const c = await search(id.query, { categoryId: cat.id });
  if (c.error) console.log(`  C failed: ${c.error}`);
  else {
    const sc = score(c.items, id);
    console.log(`  C category ${String(cat.id).padStart(6)}   results ${String(sc.n).padStart(2)}  relevant ${String(sc.relevant).padStart(2)}  used ${String(sc.usedN).padStart(2)}  median ${fmt(sc.median)}   (${cat.name}, ${cat.n}/${sa.relevant} of A's relevant)`);
  }
}
