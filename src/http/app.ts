import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';
import { createAttachmentFiles } from './attachments.js';
import type { AppContext } from './context.js';
import { limitsFrom } from './context.js';
import { invalid, toWireError } from './errors.js';
import { createHumanIdempotency } from './human-idempotency.js';
import { assertUsablePasswordHash } from './password.js';
import { createRateLimiter } from './rate-limit.js';
import { adminRoutes } from './routes/admin.js';
import { agentRoutes } from './routes/agent.js';
import { WriteSignal } from './signal.js';
import { staticRoutes } from './static.js';

export interface AppOptions {
  readonly store: Store;
  readonly config: Config;
  /** Directory holding the built SPA. A missing one serves a placeholder. */
  readonly uiRoot?: string | undefined;
  readonly logger?: FastifyServerOptions['logger'] | undefined;
}

/** Twelve hours. The design says "a fixed lifetime" and does not pick one. */
const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** A password is the one credential worth guessing, so logins get their own. */
const LOGINS_PER_MINUTE = 10;

const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { store, config } = options;
  // A hash nobody could ever match is a misconfiguration, and misconfiguration
  // is a refusal to start rather than a login that always fails.
  assertUsablePasswordHash(config.DOGPARK_PASSWORD_HASH);

  const limits = limitsFrom(config);
  const ctx: AppContext = {
    store,
    config,
    limits,
    files: createAttachmentFiles(`${config.DOGPARK_DATA_DIR}/attachments`),
    writes: new WriteSignal(),
    agentLimiter: createRateLimiter(limits.requestsPerMinute),
    loginLimiter: createRateLimiter(LOGINS_PER_MINUTE),
    humanPosts: createHumanIdempotency(),
    // Only a deployment that has declared a TLS-terminating proxy can send a
    // Secure cookie back at all; without one Dogpark binds loopback and a
    // Secure cookie would simply never return, locking the human out of a
    // development instance. See `resolveBinding` in server.ts.
    secureCookies: config.trustProxy,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    now: () => new Date(),
  };

  const app = Fastify({
    // Believed only when declared: otherwise X-Forwarded-For is a header any
    // client can write, and the rate limiter would key on a fiction.
    trustProxy: config.trustProxy,
    bodyLimit: config.DOGPARK_MAX_MESSAGE_BYTES + 64 * 1024,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  app.setErrorHandler((error, request, reply) => {
    const wire = toWireError(error);
    if (wire.status >= 500) request.log.error({ err: error }, 'request failed');
    if (wire.body.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(wire.body.retryAfterSeconds));
    }
    return reply.code(wire.status).type('application/json; charset=utf-8').send(wire.body);
  });

  // An unrouted path is `not_found` in the same shape as everything else, so a
  // client never has to tell a missing route from a hidden resource.
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).type('application/json; charset=utf-8').send({
      code: 'not_found',
      message: 'not found',
    }),
  );

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    // Routes that serve something a browser might render set their own.
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', DEFAULT_CSP);
    }
    return payload;
  });

  /**
   * Told there is a proxy, and the proxy says this request was plaintext: the
   * bearer token or session cookie has already crossed the wire in the clear.
   * Refused rather than served. A proxy that sets no `X-Forwarded-Proto` at
   * all says nothing, and is not second-guessed.
   */
  app.addHook('onRequest', async (request) => {
    if (!config.trustProxy || !request.url.startsWith('/api/')) return;
    const declared = request.headers['x-forwarded-proto'];
    if (declared === undefined) return;
    const proto = String(declared).split(',')[0]?.trim().toLowerCase();
    if (proto !== undefined && proto !== '' && proto !== 'https') {
      throw invalid(
        'this deployment is configured behind a TLS-terminating proxy, but the request ' +
          `arrived over ${proto}; refusing to accept credentials over plaintext`,
      );
    }
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: limits.maxAttachmentBytes,
      fieldSize: limits.maxMessageBytes + 8192,
      files: 20,
      fields: 10,
      parts: 40,
    },
  });

  const health = store.database.prepare<[], { ok: number }>('SELECT 1 AS ok');
  app.get('/health', async () => ({ ok: health.get()?.ok === 1 }));

  await app.register(agentRoutes(ctx), { prefix: '/api/agent' });
  await app.register(adminRoutes(ctx), { prefix: '/api/admin' });
  await app.register(staticRoutes(options.uiRoot));

  await app.ready();
  return app;
}
