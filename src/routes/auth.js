// Registration, sign in, sign out.
import { queryOne } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  cookieOptions, requireAuth, SESSION_COOKIE,
} from '../auth.js';

// No composition rules (no "must contain a symbol"). Current NIST guidance is
// that length beats forced variety and that complexity rules push people towards
// predictable substitutions.
const MIN_PASSWORD_LENGTH = 10;

const credentialsSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    // Pattern rather than ajv's `format: email`, which needs an extra package.
    // Real verification is sending mail; this just rejects obvious nonsense.
    email:    { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', maxLength: 254 },
    password: { type: 'string', minLength: MIN_PASSWORD_LENGTH, maxLength: 200 },
    display_name: { type: 'string', minLength: 1, maxLength: 60 },
  },
};

const publicUser = (u) => ({
  id: u.id, email: u.email, display_name: u.display_name, role: u.role,
});

export default async function authRoutes(app) {
  // --- register -----------------------------------------------------------
  app.post('/api/auth/register', {
    schema: { body: credentialsSchema },
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const email = request.body.email.trim().toLowerCase();
    const displayName = request.body.display_name?.trim() || email.split('@')[0];

    // Telling the caller an address is taken does leak that it is registered.
    // The alternative (silently succeeding, then emailing the real owner) needs
    // a mail server, which this app does not have yet -- so we take the usable
    // option and lean on the rate limit above to stop bulk address probing.
    const existing = await queryOne(`SELECT 1 FROM users WHERE email = $1`, [email]);
    if (existing) {
      return reply.code(409).send({
        error: 'email_taken', message: 'That email is already registered.',
      });
    }

    const user = await queryOne(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id, email, display_name, role`,
      [email, await hashPassword(request.body.password), displayName],
    );

    const { token } = await createSession(user.id);
    return reply.setCookie(SESSION_COOKIE, token, cookieOptions())
                .code(201).send({ data: publicUser(user) });
  });

  // --- sign in ------------------------------------------------------------
  app.post('/api/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', maxLength: 254 },
          password: { type: 'string', maxLength: 200 },
        },
      },
    },
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const email = request.body.email.trim().toLowerCase();
    const user = await queryOne(
      `SELECT id, email, display_name, role, password_hash FROM users WHERE email = $1`,
      [email],
    );

    // One message for "no such user" and for "wrong password", so the response
    // cannot be used to discover which addresses are registered. When the user
    // is missing we still run a hash so the timing matches the real path.
    const ok = user
      ? await verifyPassword(request.body.password, user.password_hash)
      : await verifyPassword(request.body.password, DUMMY_HASH);

    if (!user || !ok) {
      return reply.code(401).send({
        error: 'invalid_credentials', message: 'Email or password is incorrect.',
      });
    }

    const { token } = await createSession(user.id);
    return reply.setCookie(SESSION_COOKIE, token, cookieOptions())
                .send({ data: publicUser(user) });
  });

  // --- sign out -----------------------------------------------------------
  app.post('/api/auth/logout', async (request, reply) => {
    await destroySession(request.cookies?.[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  // --- who am I -----------------------------------------------------------
  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({
    data: publicUser(request.user),
  }));
}

// A real scrypt hash of a random value, used only to burn the same CPU time on
// the "user not found" path that a genuine verify would take.
const DUMMY_HASH = await hashPassword(
  (await import('node:crypto')).randomBytes(32).toString('hex'),
);
