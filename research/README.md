# Research — matching and confidence rebuild

Offline analysis behind the planned matcher, eBay query and confidence changes.
Nothing here runs in production. Scripts are tracked; the data they read and
write is not (`ebay-sample-*/` and `out/` are gitignored — this repo is public and
those files hold eBay listing titles and prices).

Samples: `ebay-sample-2026-09-15/` (production queries, 40 listings) and
`ebay-sample-2026-09-16/` (identity-first queries, 30 of those listings).

Run from this folder with `node <script>`, in order; each writes to `out/`.

| Script | What it answers |
|---|---|
| `01-sample-analysis.mjs` | How much of what eBay returned was the listing's product, and what filtering does to prices |
| `02-judge-accuracy.mjs` | Relevance judge vs Claude's labels on the 100 results it was tuned on |
| `03-holdout-score.mjs` | Same judge on 60 results it never saw (the honest number) |
| `04-query-building.mjs` | Production's eBay query vs the identity-first query, for every stored listing |
| `05-confidence-replay.mjs` | Draft confidence model over stored listings, vs production's confidence and ranking |
| `06-sample-filtered-replay.mjs` | Test-set listings priced from stored comps vs identity-filtered eBay results |
| `07-query-comparison.mjs` | Production's query (sample 1) vs the identity-first query (sample 2), same listings |
| `08-matcher-replay.mjs` | Matcher v2 vs v3 over stored listings: too-vague calls, scores, key merges/splits, eBay lookups needed |

`lib/identity.mjs` reads a title's identity and judges eBay results against it.
`lib/confidence.mjs` is the draft model: P(right product) × P(within 25% | right).
`out/stored-listings.json` is exported from production D1 (see `04`/`05` for the query).

Ground truth for the test set is Jordan's labels on the valuation-check artifact
(collection `labels`): https://claude.ai/artifact/6j5AAUwKvAC7Eq2PQrM5tF
