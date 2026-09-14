// Password hashing and session handling.
//
// Passwords: scrypt, which is built into Node -- no dependency, and it is a
// memory-hard KDF designed for exactly this. Each password gets its own random
// salt and the verify path uses a timing-safe comparison.
//
// Sessions: an opaque 256-bit random token handed to the browser in an
// httpOnly cookie. The database stores only the SHA-256 of that token, so a
// stolen database dump cannot be replayed as a valid login.
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { query, queryOne } from './db.js';

const scryptAsync = promisify(scrypt);

// N=16384 r=8 p=1 needs 128*N*r = 16MB per hash. Raise N if you ever want it
// slower; the stored format records the parameters so old hashes keep verifying.
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 };

export const SESSION_COOKIE = 'smt_session';
const SESSION_TTL_DAYS = 30;

/** Hash a password into a self-describing string: scrypt$N$r$p$salt$hash */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), key.toString('base64'),
  ].join('$');
}

/** Verify a password against a stored hash. Never throws on malformed input. */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scryptAsync(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** Create a session row and return the raw token to put in the cookie. */
export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

/** Look up the user behind a session token. Returns undefined if invalid/expired. */
export async function userForToken(token) {
  if (!token) return undefined;
  return queryOne(
    `SELECT u.id, u.email, u.display_name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
}

export async function destroySession(token) {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

/** Delete expired sessions. Called periodically by the server. */
export async function purgeExpiredSessions() {
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
}

export function cookieOptions() {
  return {
    httpOnly: true,                                   // JS on the page cannot read it
    secure: process.env.COOKIE_SECURE === 'true',     // HTTPS-only in production
    sameSite: 'lax',                                  // blocks cross-site CSRF POSTs
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86_400,
  };
}

// --- Fastify hooks ---------------------------------------------------------

/** Attaches request.user when a valid session cookie is present. Never rejects. */
export async function attachUser(request) {
  request.user = await userForToken(request.cookies?.[SESSION_COOKIE]);
}

/** Route guard: must be signed in. */
export async function requireAuth(request, reply) {
  if (!request.user) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Sign in to do that.' });
  }
}

/** Route guard: must be signed in as an admin. */
export async function requireAdmin(request, reply) {
  if (!request.user) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Sign in to do that.' });
  }
  if (request.user.role !== 'admin') {
    // 404-style refusal would be friendlier to attackers; 403 is honest and this
    // endpoint's existence is not a secret.
    return reply.code(403).send({ error: 'forbidden', message: 'Admins only.' });
  }
}
