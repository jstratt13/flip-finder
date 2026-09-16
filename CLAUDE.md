# Flip Finder

Resale-arbitrage tool for a solo developer (Jordan) and one partner. A browser
extension captures Craigslist and Facebook Marketplace listings as they browse; a
Cloudflare Worker normalises them, matches each to a product, prices it against eBay,
subtracts fees/shipping/pickup, and scores it; a React dashboard ranks what's worth
buying and records what was bought and sold.

This file holds what doesn't change often: rules, architecture, how to work here.
**Current status, open decisions and outstanding work live in the handoff page:**
https://claude.ai/artifact/S9E3zJQvturGPAC1WEj7cY — read it first.

## Live

| | |
|---|---|
| Dashboard | https://jstratt13.github.io/flip-finder/ (GitHub Pages, public repo) |
| Worker | https://flip-finder-worker.jordan-c-stratton.workers.dev (cron `*/5 * * * *`) |
| Repo | github.com/jstratt13/flip-finder — **public**: never commit secrets or eBay data |
| Storage | Cloudflare D1 `flip-finder` + KV `CACHE` (eBay token only) |
| Plan | **Cloudflare Workers free plan** — see Limits |

## Rules that are not up for relitigating

- **Craigslist and Facebook are extension-capture only. Never propose automated scraping,**
  headless browsing, proxies or IP rotation. If a source blocks us, stop.
- **eBay only through the official Browse API.** Production keyset is exempt from
  Marketplace Account Deletion because we store no eBay user data — keep it that way
  (titles/prices/condition/category only, never seller details).
- **The model declines to guess.** No trustworthy comps → no score → not ranked. A confident
  wrong number is the failure mode everything is designed against.
- **Nothing auto-tunes.** Calibration and research report suggestions; Jordan changes
  `worker/src/config.js`. Don't add code that adjusts parameters from data.
- **Jordan decides model and product changes.** Present options with measured numbers and a
  recommendation; don't ship model changes he hasn't approved.
- **Refused at ingest (Jordan's rules):** no price, price < $5 or > $1,000, whole vehicles
  (parts are fine), and **any new listing whose condition nobody stated** — no description at all,
  or a description that never mentions condition. Title words and a source condition field count.
  **Listings sold for parts are refused too** ("for parts", "not working", "needs repair", "as-is").
  Listings already stored are never refused, so a later grid card still carries a price drop in.
- **Free tier only** unless Jordan approves otherwise (Workers Paid at $5/mo is his open call).
- **Stack:** Vite + React (hooks) + plain CSS in `src/index.css`. No TypeScript, Tailwind,
  UI libraries or state libraries. Worker is plain ES modules, tested with `node --test`.

## Working with Jordan

- Direct, technical, dense. Show numbers. Say plainly when something failed or is unverified.
- **His terminal mangles long pastes.** Give one short command per code block; set variables
  (`W=…`) first and compose. Never two commands in one paste — if one prompts, the next
  becomes its input. Secrets go in through `wrangler secret put` prompts, never the command line.
- **Verify, don't assume.** Tail production after deploys; check the live bundle after Pages
  deploys; measure before claiming a fix. Verification has caught real bugs repeatedly.
- **Ask before destructive or production-data operations** (deleting rows, requeueing,
  expiring caches, changing secrets). Tell him before touching the worker when he's asked
  for dashboard-only work.
- Branch per change, clear commit messages that explain *why*, merge fast-forward to `main`.
  End commit messages with the Co-Authored-By line from the session instructions.
- He can't be asked to sign in for Claude; Claude doesn't sign in to the dashboard. Preview UI
  with example data (see the design preview approach in git history) or ask him to check.

## Architecture

```
extension/ ── capture (grid + detail) ──▶ POST /ingest
worker/    ── ingest ─▶ D1 listings ─▶ cron: sweep → re-match → queue → match → comps → score
src/       ── dashboard: Opportunities · Captured · Watchlist · Inventory
research/  ── offline analysis scripts (tracked); data in research/ebay-sample-*/, research/out/ (ignored)
```

Key worker files:

| File | Role |
|---|---|
| `src/config.js` | Every tunable parameter; capture price range; vehicle/bulky vocab; `VAGUE_MATCH_BELOW` |
| `src/ingest.js` | Normalise, refuse out-of-scope, upsert gated on real change, condition from merged text |
| `src/vehicles.js` | Whole-vehicle detection (refused at ingest) |
| `src/match.js` | Title → `product_key` + `match_score`; `MATCHER_VERSION` bump re-matches everything |
| `src/identity.js` | Title identity (brand/line/code/generation/variant) → eBay query; judges eBay results |
| `src/ebay.js` | OAuth, one combined new+used search per product, relevance-filtered comps |
| `src/localcomps.js` | Bulky goods priced from local asks |
| `src/resolve.js` | Cron orchestration; subrequest budget; indexed scoring queue with backoff; shadow v2 |
| `src/score.js` | Profit/ROI/confidence (v1) and ranking score |
| `src/valuation-confidence.js` | Confidence v2 = P(right product) × P(within 25% \| right). **Shadow only** |
| `src/captured.js` | Captured tab: reason computed in SQL, mirrors `rankingReason` (parity-tested) |
| `src/budget.js`, `src/d1.js` | Subrequest meter; IN-list chunking for D1's 100-parameter limit |

## Limits (free plan) — design around these

- **50 subrequests per invocation** (every D1 query, KV op and fetch). `budget.js` meters calls
  and stops pricing at 45.
- **10 ms CPU per invocation.** Production cron runs exceed it (35–92 ms observed); Cloudflare has
  tolerated it so far. Jordan accepts the risk and upgrades if runs get terminated
  (`outcome: exceededCpu` in `wrangler tail`).
- **D1: 100 bound parameters per statement** (use `allIn`/`chunk` from `d1.js`), 100k rows
  written/day, 5M rows read/day. Each index touched counts as a written row.
- **eBay Browse: 5,000 calls/day.** One call per product; the worker stops at 4,500/rolling 24h.
  `EBAY_PRODUCTS_PER_RUN = 7` (Jordan). Comps cached 14 days (empty results 3).

## Deploy

Order matters: migrations before the worker, the worker before a dashboard that depends on it.

```bash
cd ~/Projects/flip-finder/worker
npx wrangler d1 migrations apply flip-finder --remote
npx wrangler deploy
cd ~/Projects/flip-finder
VITE_WORKER_URL=https://flip-finder-worker.jordan-c-stratton.workers.dev npm run deploy
```

Then: `curl …/health`, tail one cron run (`npx wrangler tail flip-finder-worker --format json`,
cron runs log nothing on success), confirm the live Pages bundle hash with `?t=$(date +%s)`
(Pages caches `index.html`). Extension changes need a reload at `chrome://extensions`.

Local: dashboard `npm run dev` on **5174** (5173 is Jordan's other project), worker
`npx wrangler dev --port 8787 --local`, local D1 `npm run db:migrate` in `worker/`.
The desktop preview tool reads `~/.claude/launch.json` first, which launches a different
project — run the worker with wrangler directly and check `/health` shows `home: 92649`.

## Tests

`cd worker && npm test` (node:test). Conventions that matter:
- SQL behaviour is tested against the real migrations in `node:sqlite` (`recapture.test.js`,
  `captured.test.js`), not fakes — SQL WHERE clauses are the logic.
- Budget tests use a fake platform that throws at subrequest 51.
- New tests should fail on the code before the fix; check that.

## Gotchas that cost real time

- A `WHERE`-blocked upsert writes 0 D1 rows; writing identical values still writes 2–3.
- SQLite `EXISTS()` returns 0/1 — `{flag && <X/>}` renders a literal `0` in React.
- Capture batches share one `last_seen`, so paging needs `(last_seen, id)` keyset order.
- Migration-then-deploy leaves a gap where old code writes rows without new columns; backfill
  after deploy when new code relies on a column.
- `wrangler secret put` is itself a deployment. Changing `database_id` re-keys local D1.
- Local CPU measurements must be cold (fresh `node` process); warm loops understate cron cost.
