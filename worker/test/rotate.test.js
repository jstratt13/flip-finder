import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateIngestKey } from '../src/auth.js';

// Minimal D1 stand-in: serves the lookup, records the update.
function fakeDb(row) {
  const updates = [];
  return {
    updates,
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => (sql.trim().startsWith('SELECT') ? row : null),
          run: async () => {
            if (sql.trim().startsWith('UPDATE')) updates.push(args);
            return { meta: {} };
          },
        }),
      };
    },
  };
}

const account = { id: 1, name: 'Jordan', email: 'jordan@example.com' };

test('rotation issues a new key and writes it', async () => {
  const db = fakeDb(account);
  const res = await rotateIngestKey(db, 'jordan@example.com');

  assert.equal(res.name, 'Jordan');
  assert.ok(res.ingest_key, 'a key must be returned');
  assert.equal(res.ingest_key.length, 48);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0][0], res.ingest_key, 'the returned key is the stored key');
});

test('each rotation produces a different key', async () => {
  const a = await rotateIngestKey(fakeDb(account), 'jordan@example.com');
  const b = await rotateIngestKey(fakeDb(account), 'jordan@example.com');
  assert.notEqual(a.ingest_key, b.ingest_key);
});

test('email matching ignores case and surrounding space', async () => {
  const res = await rotateIngestKey(fakeDb(account), '  Jordan@Example.COM  ');
  assert.ok(res.ingest_key);
});

test('an unknown or inactive account rotates nothing', async () => {
  // The lookup filters on active = 1, so a deactivated account looks absent.
  const db = fakeDb(null);
  const res = await rotateIngestKey(db, 'nobody@example.com');

  assert.equal(res.error, 'no active account with that email');
  assert.equal(db.updates.length, 0, 'must not write on a miss');
});

test('a missing email is rejected rather than matching something', async () => {
  for (const bad of [null, undefined, '']) {
    const db = fakeDb(null);
    const res = await rotateIngestKey(db, bad);
    assert.ok(res.error);
    assert.equal(db.updates.length, 0);
  }
});
