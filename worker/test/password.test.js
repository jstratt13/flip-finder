import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changePassword, hashPassword, randomHex, signJWT, verifyJWT } from '../src/auth.js';

// Minimal D1 stand-in: enough to serve the one SELECT and capture the UPDATE.
function fakeDb(row) {
  const updates = [];
  return {
    updates,
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => (sql.startsWith('SELECT') ? row : null),
          run: async () => {
            if (sql.trim().startsWith('UPDATE')) updates.push(args);
            return { meta: {} };
          },
        }),
      };
    },
  };
}

async function accountWith(password) {
  const salt = randomHex(16);
  return {
    id: 1,
    name: 'Jordan',
    email: 'j@example.com',
    active: 1,
    token_version: 3,
    salt,
    password_hash: await hashPassword(password, salt),
  };
}

test('the current password is required, even holding a valid session', async () => {
  // Otherwise a stolen token could lock the real owner out of their account.
  const db = fakeDb(await accountWith('correct-horse-battery'));
  const res = await changePassword(db, 1, 'not-the-password', 'a-brand-new-password');

  assert.equal(res.error, 'current password is incorrect');
  assert.equal(db.updates.length, 0, 'nothing should have been written');
});

test('a correct current password rotates the credential', async () => {
  const account = await accountWith('correct-horse-battery');
  const db = fakeDb(account);
  const res = await changePassword(db, 1, 'correct-horse-battery', 'a-brand-new-password');

  assert.equal(res.ok, true);
  assert.equal(db.updates.length, 1);

  const [newHash, newSalt] = db.updates[0];
  assert.notEqual(newSalt, account.salt, 'a fresh salt must be generated');
  assert.notEqual(newHash, account.password_hash);
  assert.equal(newHash, await hashPassword('a-brand-new-password', newSalt));
});

test('short passwords are refused before anything is read or written', async () => {
  const db = fakeDb(await accountWith('correct-horse-battery'));
  const res = await changePassword(db, 1, 'correct-horse-battery', 'short');

  assert.match(res.error, /at least 10 characters/);
  assert.equal(db.updates.length, 0);
});

test('changing the password bumps the token version', async () => {
  const db = fakeDb(await accountWith('correct-horse-battery'));
  const res = await changePassword(db, 1, 'correct-horse-battery', 'a-brand-new-password');
  assert.equal(res.token_version, 4, 'was 3, must advance');
});

test('a deactivated account cannot change its password', async () => {
  // The SELECT filters on active = 1, so the row simply is not there.
  const db = fakeDb(null);
  const res = await changePassword(db, 1, 'correct-horse-battery', 'a-brand-new-password');
  assert.equal(res.error, 'account not found');
});

test('tokens carry the version they were issued under', async () => {
  const secret = 'test-secret';
  const token = await signJWT({ sub: 1, name: 'Jordan', tv: 3 }, secret);
  const payload = await verifyJWT(token, secret);

  assert.equal(payload.tv, 3);
  // The worker compares this against the stored version on every request, which
  // is what makes an old session stop working the moment the password changes.
  assert.notEqual(payload.tv, 4);
});
