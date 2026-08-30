import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';
import { attachmentRoot, createAttachmentFiles } from './attachments.js';
import type { AppContext } from './context.js';
import { limitsFrom } from './context.js';
import { invalid, toWireError } from './errors.js';
import { assertUsablePasswordHash } from './password.js';
import { createRateLimiter } from './rate-limit.js';
import { adminRoutes } from './routes/admin.js';
import { agentRoutes } from './routes/agent.js';
import { WriteSignals } from './signal.js';
import { staticRoutes } from './static.js';

export interface AppOptions {
  readonly store: Store;
  readonly config: Config;
  /** Directory holding the built SPA. A missing one serves a placeholder. */
  readonly uiRoot?: string | undefined;
  /** The agent guide on disk. A missing one is simply not served. */
  readonly guidePath?: string | undefined;
  readonly logger?: FastifyServerOptions['logger'] | undefined;
}

/** Twelve hours. The design says "a fixed lifetime" and does not pick one. */
const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** A password is the one credential worth guessing, so logins get their own. */
const LOGINS_PER_MINUTE = 10;

/**
 * Failed bearer authentications tolerated per minute, per source address and
 * per claimed agent id. A key that does not verify is never a healthy client's
 * ordinary traffic, so this is deliberately far below `requestsPerMinute`: it
 * is the ceiling on unauthenticated hashing, and on how fast a stranger can
 * inflate an agent's failed-attempt counter.
 */
const FAILED_AUTHS_PER_MINUTE = 20;

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
    files: createAttachmentFiles(attachmentRoot(config.DOGPARK_DATA_DIR)),
    writes: new WriteSignals(),
    agentLimiter: createRateLimiter(limits.requestsPerMinute),
    loginLimiter: createRateLimiter(LOGINS_PER_MINUTE),
    failedAuthLimiter: createRateLimiter(FAILED_AUTHS_PER_MINUTE),
    // Only under a declared TLS proxy: on loopback a Secure cookie would never
    // come back, locking the human out of a development instance (ADR-0016).
    secureCookies: config.behindProxy,
    pageLimit: (asked) => Math.min(asked ?? limits.maxPageSize, limits.maxPageSize),
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    now: () => new Date(),
  };

  const app = Fastify({
    // The declared addresses, never `true`: believing X-Forwarded-* from any
    // peer lets it claim any client address, and https over plaintext
    // (ADR-0016).
    trustProxy: config.trustProxy === false ? false : [...config.trustProxy],
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
   * An empty JSON body is no body, not a malformed one. Several admin routes
   * change state without carrying anything — `PUT .../members/:agentId`, the
   * archive pair — and a client that sets `Content-Type: application/json`
   * anyway is being tidy, not wrong. A body that is present but unparseable is
   * still `invalid_request`, in our shape rather than Fastify's.
   */
  app.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      if (body.trim() === '') {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body) as unknown);
      } catch {
        done(invalid('request body is not valid JSON'), undefined);
      }
    },
  );

  await app.register(fastifyCookie);
  /**
   * The file count is refused by `collectPost`, not here: the plugin's own
   * limit fires while the previous file is still streaming to disk and tears
   * the request down under it, which surfaces as a premature-close stream
   * error — a 500 — rather than a refusal. One more than Dogpark accepts, so
   * the part that breaks the limit is seen and refused as `too_large` before
   * a byte of it is written. The plugin's count stays as a backstop.
   */
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: limits.maxAttachmentBytes,
      fieldSize: limits.maxMessageBytes + 8192,
      files: limits.maxAttachmentsPerMessage + 1,
      fields: 10,
      parts: limits.maxAttachmentsPerMessage + 20,
    },
  });

  /**
   * Shutdown must not wait out every open long poll. `preClose` runs before
   * the server stops accepting and before in-flight requests are awaited, so
   * waking the waiters here lets each return its page and finish in the time
   * it takes to read one, rather than in `maxWaitSeconds`.
   */
  app.addHook('preClose', async () => {
    ctx.writes.agentVisible();
  });

  const health = store.database.prepare<[], { ok: number }>('SELECT 1 AS ok');
  app.get('/health', async () => ({ ok: health.get()?.ok === 1 }));

  /**
   * A declared proxy must prove TLS on every API request. Silence is refused
   * rather than waved through, because proxy mode binds 0.0.0.0 and a direct
   * caller can simply omit the header (ADR-0016).
   *
   * Scoped to the `/api` plugin rather than tested against the raw URL: the
   * router decodes percent-escapes before matching, so `/%61pi/...` reaches
   * an API route while failing a string prefix test. A hook inside the scope
   * runs for exactly the routes the router put there.
   *
   * `request.protocol`, not the raw header: `trustProxy` filters only what
   * Fastify derives, so the raw `X-Forwarded-Proto` is whatever any peer sent.
   * The derived value is `https` only when a declared proxy said so.
   */
  await app.register(
    async (api) => {
      if (config.behindProxy) {
        api.addHook('onRequest', async (request) => {
          if (request.protocol === 'https') return;
          const raw = request.headers['x-forwarded-proto'];
          const claimed =
            String(raw ?? '')
              .split(',')[0]
              ?.trim()
              .toLowerCase() ?? '';
          const seen =
            claimed === ''
              ? 'X-Forwarded-Proto: absent'
              : `X-Forwarded-Proto: ${claimed}, believed only from a declared proxy`;
          throw invalid(
            'this deployment is configured behind a TLS-terminating proxy, but the request ' +
              `did not arrive over one (${seen}); refusing to accept credentials over plaintext`,
          );
        });
      }
      await api.register(agentRoutes(ctx), { prefix: '/agent' });
      await api.register(adminRoutes(ctx), { prefix: '/admin' });
    },
    { prefix: '/api' },
  );
  await app.register(staticRoutes(options.uiRoot, options.guidePath));

  await app.ready();
  return app;
}
