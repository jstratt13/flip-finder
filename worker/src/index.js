import { ingestBatch } from './ingest.js';
import { resolvePending } from './resolve.js';
import { HOME, SCORING } from './config.js';
import { CATEGORIES } from './categorize.js';
import { calibrate, localMarketRatio } from './calibrate.js';
import {
  authenticate, changePassword, contributorForKey, createContributor,
  listContributors, rotateIngestKey, signJWT, verifyJWT,
} from './auth.js';

const CORS_BASE = {
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Ingest-Key,X-Admin-Key,Authorization',
};

// Unset (local dev) allows any origin. In production ALLOWED_ORIGINS pins this
// to the dashboard's own origin: auth is Bearer-token rather than cookie-based
// so a wildcard isn't directly exploitable, but there's no reason to let an
// arbitrary page probe the API. The extension is unaffected — it fetches from a
// service worker against a host in its own host_permissions, not via CORS.
function corsHeaders(request, env) {
  const allowed = String(env?.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!allowed.length) return { ...CORS_BASE, 'Access-Control-Allow-Origin': '*' };

  const origin = request.headers.get('Origin');
  // Omitting the header entirely is what makes the browser refuse — never echo
  // back an origin that isn't on the list.
  return origin && allowed.includes(origin)
    ? { ...CORS_BASE, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : { ...CORS_BASE, Vary: 'Origin' };
}

function withCors(res, request, env) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const unauthorized = () => json({ error: 'unauthorized' }, 401);

// A placeholder secret that reaches production is a real hole — anyone reading
// the repo could forge tokens. Fail loudly at the door rather than serving.
const PLACEHOLDER = /do-not-deploy|change-me|^$/i;

function misconfigured(env) {
  const problems = [];
  if (!env.JWT_SECRET || PLACEHOLDER.test(env.JWT_SECRET)) problems.push('JWT_SECRET');
  if (!env.ADMIN_KEY || PLACEHOLDER.test(env.ADMIN_KEY)) problems.push('ADMIN_KEY');
  return problems;
}

// Three separate credentials, deliberately. A JWT identifies a person using the
// dashboard; an ingest key identifies a capturing extension and can be revoked
// per person; the admin key is a bootstrap secret that only provisions accounts.
async function currentUser(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !env.JWT_SECRET) return null;

  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;

  // A valid signature alone isn't enough. Checking the account on each request
  // is what makes deactivation and password changes take effect immediately
  // rather than whenever the token happens to expire. One indexed read.
  const row = await env.DB.prepare(
    'SELECT id, name, email, active, token_version FROM contributors WHERE id = ?'
  )
    .bind(payload.sub)
    .first();

  if (!row || !row.active) return null;
  if (row.token_version !== payload.tv) return null;

  return { sub: row.id, name: row.name, email: row.email };
}

function isAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key');
  return Boolean(env.ADMIN_KEY) && key === env.ADMIN_KEY;
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  const user = await authenticate(env.DB, body?.email, body?.password);
  if (!user) return json({ error: 'invalid email or password' }, 401);

  const token = await signJWT(
    { sub: user.id, name: user.name, email: user.email, tv: user.token_version },
    env.JWT_SECRET
  );
  return json({ token, user: { id: user.id, name: user.name, email: user.email } });
}

async function handlePasswordChange(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body?.current_password || !body?.new_password) {
    return json({ error: 'current_password and new_password required' }, 400);
  }
  if (body.current_password === body.new_password) {
    return json({ error: 'new password must be different from the current one' }, 400);
  }

  const result = await changePassword(env.DB, user.sub, body.current_password, body.new_password);
  if (result.error) return json({ error: result.error }, 400);

  // Deliberately no new token: the change invalidated every session including
  // this one, so signing back in is the honest outcome.
  return json({ ok: true, signed_out: true });
}

async function handleCreateContributor(request, env) {
  if (!isAdmin(request, env)) return unauthorized();

  const body = await request.json().catch(() => null);
  if (!body?.name || !body?.email || !body?.password) {
    return json({ error: 'name, email and password required' }, 400);
  }
  if (String(body.password).length < 10) {
    return json({ error: 'password must be at least 10 characters' }, 400);
  }

  try {
    const created = await createContributor(env.DB, body);
    // The only time the ingest key is ever returned — it is not retrievable later.
    return json(created, 201);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return json({ error: 'that email already has an account' }, 409);
    }
    throw err;
  }
}

async function handleRotateKey(request, env) {
  if (!isAdmin(request, env)) return unauthorized();

  const body = await request.json().catch(() => null);
  if (!body?.email) return json({ error: 'email required' }, 400);

  const result = await rotateIngestKey(env.DB, body.email);
  if (result.error) return json(result, 404);

  return json({ ...result, note: 'previous key is now invalid' });
}

async function handleListContributors(request, env) {
  if (!isAdmin(request, env)) return unauthorized();
  return json({ contributors: await listContributors(env.DB) });
}

async function handleIngest(request, env) {
  const contributor = await contributorForKey(env.DB, request.headers.get('X-Ingest-Key'));
  if (!contributor) return unauthorized();

  const body = await request.json().catch(() => null);
  const items = Array.isArray(body) ? body : body?.items;
  if (!Array.isArray(items)) return json({ error: 'expected { items: [...] }' }, 400);
  if (items.length > 500) return json({ error: 'batch too large (max 500)' }, 400);

  const origin = body?.origin?.lat != null ? body.origin : HOME;
  const result = await ingestBatch(env.DB, items, origin, contributor.id);
  return json({ ...result, captured_by: contributor.name });
}

async function handleListings(request, env) {
  const u = new URL(request.url);
  const source = u.searchParams.get('source');
  const limit = Math.min(Number(u.searchParams.get('limit')) || 100, 500);
  const maxDistance = Number(u.searchParams.get('max_distance')) || null;

  // Already-bought listings belong in inventory, not in the buy-side ranking.
  const where = [
    "l.status = 'active'",
    'NOT EXISTS (SELECT 1 FROM acquisitions a WHERE a.listing_id = l.id)',
  ];
  const binds = [];

  if (source && source !== 'all') {
    where.push('l.source = ?');
    binds.push(source);
  }
  // Shipped listings must never be filtered out by distance.
  if (maxDistance) {
    where.push("(l.acquisition_mode = 'shipped' OR l.distance_mi <= ?)");
    binds.push(maxDistance);
  }

  // Optional tighter freshness than the 30-day sweep, for when you only want
  // things confirmed recently.
  const maxAgeDays = Number(u.searchParams.get('max_age_days')) || null;
  if (maxAgeDays) {
    where.push('l.last_seen >= ?');
    binds.push(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  }

  // An empty selection means no filter, same as omitting the parameter.
  const cats = (u.searchParams.get('categories') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cats.length) {
    where.push(`l.category IN (${cats.map(() => '?').join(',')})`);
    binds.push(...cats);
  }

  // The ranking gates are enforced here, not just defined in config. Defaults
  // come from SCORING; each can be overridden per request for tuning.
  if (u.searchParams.get('include_unscored') === '1') {
    // Diagnostic view: everything, scored or not.
  } else {
    const num = (k, fallback) => {
      const raw = u.searchParams.get(k);
      return raw == null || raw === '' ? fallback : Number(raw);
    };
    where.push('s.score IS NOT NULL');
    where.push('s.profit >= ?');
    binds.push(num('min_profit', SCORING.min_profit));
    where.push('s.confidence >= ?');
    binds.push(num('min_confidence', SCORING.min_confidence));
    where.push('s.roi >= ?');
    binds.push(num('min_roi', SCORING.min_roi));
  }

  const sql = `
    SELECT l.id, l.source, l.title, l.url, l.price, l.thumb_url, l.location_name,
           l.distance_mi, l.geo_source, l.acquisition_mode, l.category, l.last_seen, l.first_seen,
           -- Price history was recorded from the start and never read. The
           -- earliest observation is what a drop is measured against.
           (SELECT p.price FROM price_history p WHERE p.listing_id = l.id
             ORDER BY p.observed_at ASC LIMIT 1) AS first_price,
           (SELECT MIN(p.observed_at) FROM price_history p WHERE p.listing_id = l.id) AS first_priced_at,
           c.band AS condition_band, c.confidence AS condition_confidence,
           s.profit, s.roi, s.confidence, s.score, s.anchor_value, s.anchor_source,
           s.est_net_blended, s.acquisition_cost
    FROM listings l
    LEFT JOIN conditions c ON c.listing_id = l.id
    LEFT JOIN scores s ON s.listing_id = l.id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(s.score, -1) DESC, l.last_seen DESC
    LIMIT ?`;

  const { results } = await env.DB.prepare(sql).bind(...binds, limit).all();

  const listings = results.map((r) => {
    // A seller who has already come down is demonstrably willing to move, which
    // is worth knowing before you go and negotiate. Reported, not scored — see
    // the note in the dashboard for why the direction isn't settled.
    const dropped =
      r.first_price > 0 && r.price != null && r.price < r.first_price
        ? {
            price_drop_pct: (r.first_price - r.price) / r.first_price,
            original_price: r.first_price,
            days_listed:
              r.first_priced_at != null
                ? (Date.now() - r.first_priced_at) / (24 * 60 * 60 * 1000)
                : null,
          }
        : { price_drop_pct: null, original_price: null, days_listed: null };

    return { ...r, first_price: undefined, first_priced_at: undefined, ...dropped };
  });

  return json({ count: listings.length, listings });
}

// Everything captured, with why each one isn't in the ranking.
//
// Without this the dashboard looks identical whether nothing good turned up
// today or capture broke three weeks ago. The reason per listing is the whole
// point — "no product match" and "awaiting comps" call for very different
// responses, and neither is visible from an empty Opportunities tab.
function rankingReason(r, gates) {
  if (r.acquired) return { code: 'acquired', label: 'Bought' };
  if (r.status !== 'active') return { code: 'gone', label: 'No longer listed' };
  if (r.price == null) return { code: 'no_price', label: 'No price' };
  if (!r.product_key) return { code: 'no_match', label: 'No product match' };
  if (r.active_median == null && r.retail_price == null) {
    return { code: 'no_comps', label: 'Awaiting comps' };
  }
  if (r.score == null) {
    return { code: 'no_margin', label: 'No margin at this price' };
  }
  if (r.profit < gates.min_profit) {
    return { code: 'low_profit', label: `Profit $${Math.round(r.profit)}` };
  }
  if (r.confidence < gates.min_confidence) {
    return { code: 'low_confidence', label: `Confidence ${r.confidence.toFixed(2)}` };
  }
  if (r.roi < gates.min_roi) {
    return { code: 'low_roi', label: `ROI ${Math.round(r.roi * 100)}%` };
  }
  return { code: 'ranking', label: 'In the ranking' };
}

async function handleCaptured(request, env) {
  const u = new URL(request.url);
  const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 500);
  const source = u.searchParams.get('source');

  const where = [];
  const binds = [];
  if (source && source !== 'all') {
    where.push('l.source = ?');
    binds.push(source);
  }

  const { results } = await env.DB.prepare(
    `SELECT l.id, l.source, l.title, l.price, l.url, l.thumb_url, l.category,
            l.last_seen, l.status, l.distance_mi, l.geo_source, l.acquisition_mode,
            c.band AS condition_band,
            m.product_key, m.match_score,
            cp.active_median, cp.retail_price, cp.n_active,
            s.score, s.profit, s.roi, s.confidence, s.anchor_value, s.anchor_source,
            s.est_net_blended, s.acquisition_cost,
            EXISTS (SELECT 1 FROM acquisitions a WHERE a.listing_id = l.id) AS acquired
     FROM listings l
     LEFT JOIN conditions c ON c.listing_id = l.id
     LEFT JOIN listing_matches m ON m.listing_id = l.id
     LEFT JOIN comps cp ON cp.product_key = m.product_key
     LEFT JOIN scores s ON s.listing_id = l.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY l.last_seen DESC
     LIMIT ?`
  )
    .bind(...binds, limit)
    .all();

  const listings = results.map((r) => ({ ...r, reason: rankingReason(r, SCORING) }));

  const summary = {};
  for (const l of listings) summary[l.reason.code] = (summary[l.reason.code] ?? 0) + 1;

  return json({ count: listings.length, summary, listings });
}

// Counts drive the checkbox list, and they respect the same gates as the
// ranking — a category showing (0) genuinely has nothing worth looking at,
// rather than nothing captured.
async function handleCategories(request, env) {
  const u = new URL(request.url);
  const source = u.searchParams.get('source');

  // Must mirror handleListings exactly, or a badge promises rows the list
  // won't show — including items already bought.
  const where = [
    "l.status = 'active'",
    'NOT EXISTS (SELECT 1 FROM acquisitions a WHERE a.listing_id = l.id)',
    's.score IS NOT NULL',
    's.profit >= ?',
    's.confidence >= ?',
    's.roi >= ?',
  ];
  const binds = [SCORING.min_profit, SCORING.min_confidence, SCORING.min_roi];

  if (source && source !== 'all') {
    where.push('l.source = ?');
    binds.push(source);
  }

  const { results } = await env.DB.prepare(
    `SELECT COALESCE(l.category, 'other') AS category, COUNT(*) AS n
     FROM listings l JOIN scores s ON s.listing_id = l.id
     WHERE ${where.join(' AND ')}
     GROUP BY 1`
  )
    .bind(...binds)
    .all();

  const counts = new Map(results.map((r) => [r.category, r.n]));
  return json({
    categories: CATEGORIES.map((c) => ({ category: c, count: counts.get(c) ?? 0 })),
    total: results.reduce((sum, r) => sum + r.n, 0),
  });
}

// What you own: bought but not yet sold, plus everything already closed out.
// est_snapshot is the frozen prediction, so predicted and realised profit sit
// side by side here.
async function outcomeRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.id AS acquisition_id, a.listing_id, a.acquired_at, a.price_paid, a.pickup_cost,
            a.est_snapshot, a.notes,
            ca.name AS acquired_by,
            l.title, l.thumb_url, l.source, l.url, l.category,
            c.band AS condition_band,
            s.id AS sale_id, s.sold_at, s.venue, s.sale_price, s.fees_paid, s.shipping_paid,
            cs.name AS sold_by
     FROM acquisitions a
     LEFT JOIN contributors ca ON ca.id = a.acquired_by
     LEFT JOIN listings l ON l.id = a.listing_id
     LEFT JOIN conditions c ON c.listing_id = a.listing_id
     LEFT JOIN sales s ON s.acquisition_id = a.id
     -- Must come after the sales join: an ON clause cannot reference a table
     -- joined to its right.
     LEFT JOIN contributors cs ON cs.id = s.sold_by
     ORDER BY (s.id IS NOT NULL), a.acquired_at DESC`
  ).all();

  return results.map((r) => {
    const est = JSON.parse(r.est_snapshot || '{}');
    const cost = r.price_paid + (r.pickup_cost ?? 0);
    const actual_profit =
      r.sale_id == null
        ? null
        : r.sale_price - (r.fees_paid ?? 0) - (r.shipping_paid ?? 0) - cost;

    return {
      ...r,
      est_snapshot: undefined,
      predicted_profit: est.profit ?? null,
      // Carried for calibration: the per-venue expectation is what isolates the
      // resale estimate from what was paid.
      est_net_fb: est.est_net_fb ?? null,
      est_net_ebay: est.est_net_ebay ?? null,
      anchor_value: est.anchor_value ?? null,
      acquisition_cost: cost,
      actual_profit,
      // The whole point of freezing the estimate: how wrong was the model?
      variance: actual_profit != null && est.profit != null ? actual_profit - est.profit : null,
    };
  });
}

async function handleInventory(request, env) {
  const items = await outcomeRows(env);
  return json({ count: items.length, items });
}

async function handleCalibration(request, env) {
  // Pairs every product that has a national comp with the local sightings of
  // the same product. Bulky goods are excluded: their comps are already local,
  // so comparing them to themselves would measure nothing.
  const { results: pairs } = await env.DB.prepare(
    `SELECT m.product_key, c.active_median AS ebay_median, l.price
     FROM listing_matches m
     JOIN comps c ON c.product_key = m.product_key
     JOIN listings l ON l.id = m.listing_id
     WHERE c.source = 'ebay'
       AND c.active_median > 0
       AND l.source IN ('facebook', 'craigslist')
       AND l.price > 0
       AND l.status = 'active'`
  ).all();

  return json({
    ...calibrate(await outcomeRows(env)),
    local_market: localMarketRatio(pairs),
  });
}

// Freezes the current estimate at purchase time. Calibration compares against
// this snapshot, never against a value that drifted afterward.
async function handleAcquire(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body?.listing_id || body.price_paid == null) {
    return json({ error: 'listing_id and price_paid required' }, 400);
  }

  // Both of you can buy, so the same listing must not be claimed twice.
  const existing = await env.DB.prepare(
    `SELECT a.id, c.name FROM acquisitions a
     LEFT JOIN contributors c ON c.id = a.acquired_by
     WHERE a.listing_id = ?`
  )
    .bind(body.listing_id)
    .first();
  if (existing) {
    return json(
      { error: `already marked acquired by ${existing.name ?? 'someone'}`, acquisition_id: existing.id },
      409
    );
  }

  const snapshot = await env.DB.prepare('SELECT * FROM scores WHERE listing_id = ?')
    .bind(body.listing_id)
    .first();

  const { meta } = await env.DB.prepare(
    `INSERT INTO acquisitions (listing_id, acquired_at, price_paid, pickup_cost, est_snapshot, acquired_by, notes)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(
      body.listing_id,
      body.acquired_at ?? Date.now(),
      body.price_paid,
      body.pickup_cost ?? 0,
      JSON.stringify(snapshot ?? {}),
      user.sub,
      body.notes ?? null
    )
    .run();

  return json({ acquisition_id: meta.last_row_id, acquired_by: user.name });
}

async function handleSale(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body?.acquisition_id || body.sale_price == null || !body.venue) {
    return json({ error: 'acquisition_id, sale_price and venue required' }, 400);
  }

  const { meta } = await env.DB.prepare(
    `INSERT INTO sales (acquisition_id, sold_at, venue, sale_price, fees_paid, shipping_paid, sold_by, notes)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(
      body.acquisition_id,
      body.sold_at ?? Date.now(),
      body.venue,
      body.sale_price,
      body.fees_paid ?? 0,
      body.shipping_paid ?? 0,
      user.sub,
      body.notes ?? null
    )
    .run();

  return json({ sale_id: meta.last_row_id, sold_by: user.name });
}

export default {
  async fetch(request, env) {
    // CORS is applied in one place on the way out, so no handler can forget it
    // — an error response without it surfaces in the browser as an unhelpful
    // "Failed to fetch" rather than the actual problem.
    return withCors(await route(request, env), request, env);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(resolvePending(env));
  },
};

async function route(request, env) {
  {
    const u = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    try {
      // Open: liveness only. Deliberately says nothing about the data.
      if (u.pathname === '/health') return json({ ok: true, home: HOME.zip });

      // Everything else needs the app to be correctly configured. Serving with
      // a placeholder signing key would be worse than being down.
      const problems = misconfigured(env);
      if (problems.length) {
        return json(
          {
            error: 'worker is misconfigured and refusing requests',
            missing_or_placeholder: problems,
            fix: 'set real values with: npx wrangler secret put <NAME>',
          },
          503
        );
      }

      // Post-deploy readiness. Reports what is configured, never any value.
      if (u.pathname === '/admin/status') {
        if (!isAdmin(request, env)) return unauthorized();
        let db_ok = false;
        let migrations = null;
        try {
          const row = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM d1_migrations"
          ).first();
          migrations = row?.n ?? null;
          db_ok = true;
        } catch {
          db_ok = false;
        }
        return json({
          db_ok,
          migrations_applied: migrations,
          kv_bound: Boolean(env.CACHE),
          ebay_configured: Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
          cors_pinned: Boolean(env.ALLOWED_ORIGINS),
          cron_target: '/admin/resolve',
        });
      }

      // Every handler is awaited rather than returned bare: returning a promise
      // lets a later rejection escape this try/catch, and the error response
      // that produced carried no CORS headers, so the browser only ever saw
      // "Failed to fetch" instead of the real problem.
      if (u.pathname === '/auth/login' && request.method === 'POST') return await handleLogin(request, env);
      if (u.pathname === '/ingest' && request.method === 'POST') return await handleIngest(request, env);

      if (u.pathname === '/admin/contributors' && request.method === 'POST') {
        return await handleCreateContributor(request, env);
      }
      if (u.pathname === '/admin/contributors' && request.method === 'GET') {
        return await handleListContributors(request, env);
      }
      if (u.pathname === '/admin/rotate-key' && request.method === 'POST') {
        return await handleRotateKey(request, env);
      }
      if (u.pathname === '/admin/resolve') {
        if (!isAdmin(request, env)) return unauthorized();
        const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 500);
        const retry = u.searchParams.has('retry_now') ? 0 : undefined;
        return json(await resolvePending(env, { limit, retryUnscoredMs: retry }));
      }

      // Everything below is the dashboard and requires a signed-in person.
      const user = await currentUser(request, env);
      if (!user) return unauthorized();

      if (u.pathname === '/auth/password' && request.method === 'POST') return await handlePasswordChange(request, env, user);
      if (u.pathname === '/auth/me') return json({ user: { id: user.sub, name: user.name, email: user.email } });
      if (u.pathname === '/listings') return await handleListings(request, env);
      if (u.pathname === '/categories') return await handleCategories(request, env);
      if (u.pathname === '/captured') return await handleCaptured(request, env);
      if (u.pathname === '/inventory') return await handleInventory(request, env);
      if (u.pathname === '/calibration') return await handleCalibration(request, env);
      if (u.pathname === '/acquisitions' && request.method === 'POST') return await handleAcquire(request, env, user);
      if (u.pathname === '/sales' && request.method === 'POST') return await handleSale(request, env, user);

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  }
}
