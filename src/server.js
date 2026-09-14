// Application entry point: wires plugins, routes, and shutdown.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import { pool } from './db.js';
import { attachUser, purgeExpiredSessions } from './auth.js';
import clubRoutes from './routes/clubs.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.rateLimit] Set false in tests, which otherwise trip the
 *   auth limiter with their own repeated signups. Always on in production.
 */
export async function build({ rateLimit: enableRateLimit = true } = {}) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,          // behind nginx, so honour X-Forwarded-For
    bodyLimit: 256 * 1024,
  });

  // Browsers will not send the session cookie cross-origin unless the origin is
  // named explicitly -- a wildcard is not allowed with credentials, and that is
  // a rule worth keeping rather than working around.
  const origins = (process.env.CORS_ORIGIN ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean);

  await app.register(cors, { origin: origins.length ? origins : false, credentials: true });
  await app.register(cookie);
  if (enableRateLimit) {
    await app.register(rateLimit, {
      global: true,
      max: 300,               // per IP; individual routes tighten this further
      timeWindow: '1 minute',
    });
  }

  app.addHook('preHandler', attachUser);

  // Keep internal failures internal. Fastify's validation errors carry a
  // statusCode and are safe (and useful) to pass back; anything else is logged
  // in full and answered with a generic message.
  app.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({
        error: 'validation_failed',
        message: error.message,
      });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: error.code ?? 'request_failed',
        message: error.message,
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: 'server_error', message: 'Something went wrong on our end.',
    });
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(clubRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);

  return app;
}

// Only start listening when run directly, so tests can import build() and drive
// the app in-process without binding a port.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const app = await build();

  // Expired rows are already ignored by every query; this just stops the table
  // growing forever.
  const purge = setInterval(
    () => purgeExpiredSessions().catch((err) => app.log.error({ err }, 'session purge failed')),
    6 * 60 * 60 * 1000,
  );
  purge.unref();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      app.log.info(`${signal} received, shutting down`);
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }

  await app.listen({
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
  });
}
