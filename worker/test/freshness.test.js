import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStale } from '../src/resolve.js';
import { FRESHNESS } from '../src/config.js';

const DAY = 24 * 60 * 60 * 1000;

// Records the cutoff the sweep binds, so we can assert on what it would match
// without standing up a database.
function fakeDb(changes = 0) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind: (...args) => {
          calls.push({ sql, args });
          return { run: async () => ({ meta: { changes } }) };
        },
      };
    },
  };
}

test('sweeps on last_seen, not first_seen', () => {
  // An item re-encountered every week is demonstrably still listed, however old
  // the original post is. Sweeping on first_seen would kill exactly those.
  const db = fakeDb();
  sweepStale(db, Date.now());
  assert.match(db.calls[0].sql, /last_seen < \?/);
  assert.doesNotMatch(db.calls[0].sql, /first_seen/);
});

test('only touches listings currently active', () => {
  const db = fakeDb();
  sweepStale(db, Date.now());
  assert.match(db.calls[0].sql, /status = 'active'/);
});

test('the cutoff matches the configured window', () => {
  const now = 1_700_000_000_000;
  const db = fakeDb();
  sweepStale(db, now);

  const cutoff = db.calls[0].args[0];
  const daysBack = (now - cutoff) / DAY;
  assert.equal(daysBack, FRESHNESS.gone_after_days);
  assert.equal(FRESHNESS.gone_after_days, 30);
});

test('a listing seen inside the window survives', () => {
  const now = Date.now();
  const db = fakeDb();
  sweepStale(db, now);
  const cutoff = db.calls[0].args[0];

  // Someone away for a fortnight should not come back to an emptied dashboard.
  assert.ok(now - 14 * DAY > cutoff, 'two weeks unseen must survive');
  assert.ok(now - 29 * DAY > cutoff, 'just inside the window must survive');
  assert.ok(now - 31 * DAY < cutoff, 'past the window is swept');
});

test('reports how many it marked gone', async () => {
  assert.equal(await sweepStale(fakeDb(7), Date.now()), 7);
  assert.equal(await sweepStale(fakeDb(0), Date.now()), 0);
});

test('the stale warning fires well before the sweep does', () => {
  // The UI flags uncertainty long before anything is removed, which is the
  // whole point: absence of a sighting is not evidence of removal.
  assert.ok(FRESHNESS.stale_after_days < FRESHNESS.gone_after_days);
  assert.equal(FRESHNESS.stale_after_days, 7);
});
