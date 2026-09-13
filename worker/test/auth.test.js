import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signJWT, verifyJWT, randomHex } from '../src/auth.js';

const SECRET = 'test-secret-not-a-real-one';

test('a password hash is salted, so identical passwords differ', async () => {
  const a = await hashPassword('correct horse battery', 'salt-one');
  const b = await hashPassword('correct horse battery', 'salt-two');
  assert.notEqual(a, b);
});

test('verifyPassword accepts the right password and rejects the wrong one', async () => {
  const salt = randomHex(16);
  const hash = await hashPassword('correct horse battery', salt);
  assert.equal(await verifyPassword('correct horse battery', salt, hash), true);
  assert.equal(await verifyPassword('Correct horse battery', salt, hash), false);
  assert.equal(await verifyPassword('', salt, hash), false);
});

test('a signed token round-trips its claims', async () => {
  const token = await signJWT({ sub: 7, name: 'Jordan' }, SECRET);
  const payload = await verifyJWT(token, SECRET);
  assert.equal(payload.sub, 7);
  assert.equal(payload.name, 'Jordan');
  assert.ok(payload.exp > payload.iat);
});

test('a token signed with another secret is rejected', async () => {
  const token = await signJWT({ sub: 1 }, SECRET);
  assert.equal(await verifyJWT(token, 'a-different-secret'), null);
});

test('a tampered payload is rejected', async () => {
  const token = await signJWT({ sub: 1, name: 'Jordan' }, SECRET);
  const [head, , sig] = token.split('.');
  const forged = btoa(JSON.stringify({ sub: 999, name: 'Someone', exp: 9999999999 }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  assert.equal(await verifyJWT(`${head}.${forged}.${sig}`, SECRET), null);
});

test('an expired token is rejected', async () => {
  const token = await signJWT({ sub: 1 }, SECRET, -10);
  assert.equal(await verifyJWT(token, SECRET), null);
});

test('malformed tokens are rejected rather than throwing', async () => {
  for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', null, undefined, 'x.y.z']) {
    assert.equal(await verifyJWT(bad, SECRET), null);
  }
});

test('generated keys are unique and long enough to be unguessable', () => {
  const keys = new Set(Array.from({ length: 50 }, () => randomHex(24)));
  assert.equal(keys.size, 50);
  assert.equal(randomHex(24).length, 48);
});
