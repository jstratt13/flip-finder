// The free Workers plan allows 50 subrequests per invocation, and D1 queries,
// KV reads and writes, and outbound fetches all count. Going over doesn't fail
// one call — every call after the limit throws, including the final write that
// saves the run's scores, so the whole run is lost and retried identically.
//
// Rather than predicting what a run costs, the bindings are wrapped and every
// call is counted. Loops that can spend without bound (comp lookups) ask the
// meter before each step and stop early, leaving the rest for the next run.
//
// A db.batch() is one call to D1 however many statements it holds: production
// ran a batch of 200+ statements and failed only later, at an unrelated query.
export const SUBREQUEST_LIMIT = 50;

// Headroom for anything this count can't see.
const MARGIN = 5;

export function createMeter(limit = SUBREQUEST_LIMIT - MARGIN) {
  const meter = {
    used: 0,
    limit,
    tick: () => (meter.used += 1),
    // True if n more calls would still fit, after holding back `reserve` for
    // work that must happen later in the run.
    canSpend: (n, reserve = 0) => meter.used + n + reserve <= meter.limit,
  };
  return meter;
}

function meterStatement(stmt, meter) {
  return {
    _raw: stmt,
    bind: (...args) => meterStatement(stmt.bind(...args), meter),
    all: (...a) => (meter.tick(), stmt.all(...a)),
    run: (...a) => (meter.tick(), stmt.run(...a)),
    first: (...a) => (meter.tick(), stmt.first(...a)),
    raw: (...a) => (meter.tick(), stmt.raw(...a)),
  };
}

function meterDb(db, meter) {
  return {
    prepare: (sql) => meterStatement(db.prepare(sql), meter),
    batch: (stmts) => (meter.tick(), db.batch(stmts.map((s) => s._raw ?? s))),
  };
}

function meterKv(kv, meter) {
  if (!kv) return kv;
  return {
    get: (...a) => (meter.tick(), kv.get(...a)),
    put: (...a) => (meter.tick(), kv.put(...a)),
    delete: (...a) => (meter.tick(), kv.delete(...a)),
  };
}

// Returns an env and fetch whose every call is counted against the meter.
export function metered(env, fetchImpl, meter) {
  return {
    env: { ...env, DB: meterDb(env.DB, meter), CACHE: meterKv(env.CACHE, meter) },
    fetchImpl: (...a) => (meter.tick(), fetchImpl(...a)),
  };
}
