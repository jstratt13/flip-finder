// PBKDF2 password hashing and HS256 JWTs on WebCrypto only — available in both
// Workers and Node, so no dependency and nothing to keep patched.

const PBKDF2_ITERATIONS = 100_000;
const KEY_BITS = 256;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const enc = new TextEncoder();

function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomHex(byteLength = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS
  );
  return toHex(new Uint8Array(bits));
}

// Compares every character regardless of where the first mismatch falls, so
// the time taken doesn't leak how much of the hash was correct.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, salt, expectedHash) {
  return constantTimeEqual(await hashPassword(password, salt), expectedHash);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signJWT(payload, secret, ttlSeconds = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };

  const head = toBase64Url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims = toBase64Url(enc.encode(JSON.stringify(body)));
  const signingInput = `${head}.${claims}`;

  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyJWT(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [head, claims, sig] = parts;

  // The token is entirely attacker-controlled, so every decode below can throw
  // on malformed input. Anything that fails is simply an invalid token.
  try {
    // Verify the signature before parsing claims — never trust the payload of a
    // token whose signature hasn't been checked.
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(sig),
      enc.encode(`${head}.${claims}`)
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(claims)));
    if (typeof payload?.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createContributor(db, { name, email, password }) {
  const salt = randomHex(16);
  const password_hash = await hashPassword(password, salt);
  const ingest_key = randomHex(24);
  const now = Date.now();

  const { meta } = await db
    .prepare(
      `INSERT INTO contributors (name, email, password_hash, salt, ingest_key, active, created_at)
       VALUES (?,?,?,?,?,1,?)`
    )
    .bind(name, String(email).toLowerCase().trim(), password_hash, salt, ingest_key, now)
    .run();

  return { id: meta.last_row_id, name, email, ingest_key };
}

export async function authenticate(db, email, password) {
  const row = await db
    .prepare('SELECT * FROM contributors WHERE email = ? AND active = 1')
    .bind(String(email ?? '').toLowerCase().trim())
    .first();

  // Hash against a dummy salt when the account is missing so a wrong email and
  // a wrong password take the same time to reject.
  if (!row) {
    await hashPassword(String(password ?? ''), 'absent-account-placeholder');
    return null;
  }

  if (!(await verifyPassword(String(password ?? ''), row.salt, row.password_hash))) return null;
  return { id: row.id, name: row.name, email: row.email, token_version: row.token_version };
}

export const MIN_PASSWORD_LENGTH = 10;

// Requires the current password even though the caller already holds a valid
// token: otherwise a stolen session could lock the real owner out of their own
// account, which is the opposite of what this feature is for.
export async function changePassword(db, userId, currentPassword, newPassword) {
  if (String(newPassword ?? '').length < MIN_PASSWORD_LENGTH) {
    return { error: `new password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const row = await db.prepare('SELECT * FROM contributors WHERE id = ? AND active = 1')
    .bind(userId)
    .first();
  if (!row) return { error: 'account not found' };

  if (!(await verifyPassword(String(currentPassword ?? ''), row.salt, row.password_hash))) {
    return { error: 'current password is incorrect' };
  }

  // Fresh salt, not the old one — reusing it would leak that the password
  // changed to anyone who had seen the previous hash.
  const salt = randomHex(16);
  const password_hash = await hashPassword(newPassword, salt);

  await db
    .prepare(
      `UPDATE contributors
       SET password_hash = ?, salt = ?, token_version = token_version + 1
       WHERE id = ?`
    )
    .bind(password_hash, salt, userId)
    .run();

  // Every existing session for this account is now invalid, including the one
  // that made this request.
  return { ok: true, token_version: row.token_version + 1 };
}

// Ingest keys are shown once at creation and stored as-is, so there is no way
// to recover a lost one — only to replace it. Rotation also covers the case
// that matters more later: revoking a key that leaked, without disturbing the
// account, its history, or the other person's key.
export async function rotateIngestKey(db, email) {
  const normalized = String(email ?? '').toLowerCase().trim();

  const row = await db
    .prepare('SELECT id, name, email FROM contributors WHERE email = ? AND active = 1')
    .bind(normalized)
    .first();
  if (!row) return { error: 'no active account with that email' };

  const ingest_key = randomHex(24);
  await db
    .prepare('UPDATE contributors SET ingest_key = ? WHERE id = ?')
    .bind(ingest_key, row.id)
    .run();

  // The previous key stops working immediately — any extension still holding it
  // starts getting 401s on its next batch.
  return { id: row.id, name: row.name, email: row.email, ingest_key };
}

export async function listContributors(db) {
  const { results } = await db
    .prepare(
      `SELECT id, name, email, active, created_at,
              (SELECT COUNT(*) FROM listings l WHERE l.captured_by = c.id) AS captured
       FROM contributors c ORDER BY id`
    )
    .all();
  // Deliberately never returns ingest keys or hashes.
  return results;
}

export async function contributorForKey(db, key) {
  if (!key) return null;
  return db
    .prepare('SELECT id, name, email FROM contributors WHERE ingest_key = ? AND active = 1')
    .bind(key)
    .first();
}
