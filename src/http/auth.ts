import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { constantTimeEquals, splitKey } from '../store/ids.js';
import type { Authentication, SessionRecord } from '../store/index.js';
import type { AppContext } from './context.js';
import { csrfRefused, HttpError, unauthenticated } from './errors.js';

export const SESSION_COOKIE = 'dogpark_session';
export const CSRF_HEADER = 'x-csrf-token';

export interface ActiveSession extends SessionRecord {
  readonly token: string;
}

/**
 * Who a request turned out to be. A `WeakMap` rather than a request decorator:
 * nothing can read it without saying which request it means, and a route that
 * forgot its guard gets `undefined` rather than another request's caller.
 */
const agents = new WeakMap<FastifyRequest, Authentication>();
const sessions = new WeakMap<FastifyRequest, ActiveSession>();

export function requireAgent(request: FastifyRequest): Authentication {
  const found = agents.get(request);
  /* c8 ignore next */
  if (found === undefined) throw unauthenticated('authentication required');
  return found;
}

export function requireSession(request: FastifyRequest): ActiveSession {
  const found = sessions.get(request);
  /* c8 ignore next */
  if (found === undefined) throw unauthenticated('a session is required');
  return found;
}

/**
 * The CSRF token is derived from the session token rather than stored beside
 * it. The session token is already the secret and the browser will not hand it
 * to script (`HttpOnly`), so anything that can compute this already has the
 * session. Deriving also means the two cannot drift apart, and that a restart
 * does not leave live cookies whose tokens no longer verify.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`dogpark-csrf:${sessionToken}`, 'utf8').digest('base64url');
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The id a key claims (`splitKey`), read without verifying anything, so a
 * refused attempt can be bucketed by it. A token in no recognisable shape
 * claims nothing, and every such attempt shares one bucket.
 */
function claimedAgentId(presented: string): string {
  return splitKey(presented)?.agent ?? '';
}

/**
 * Bearer authentication, then this agent's share of `requestsPerMinute`.
 *
 * A bad key is always 401, never 429: the two failure buckets bound how often
 * a failure is counted, and refuse nothing (ADR-0015). Only failures are
 * charged; a valid key costs nothing here.
 */
export function authenticateAgent(ctx: AppContext) {
  return async function agentGuard(request: FastifyRequest): Promise<void> {
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined) {
      throw unauthenticated('expected an Authorization: Bearer dgp_… header');
    }

    const byAddress = `ip:${request.ip}`;
    const byClaim = `id:${claimedAgentId(presented)}`;
    // Whether to write the failure down, not whether to serve it (ADR-0015).
    const countFailure =
      ctx.failedAuthLimiter.peek(byAddress).allowed && ctx.failedAuthLimiter.peek(byClaim).allowed;

    const auth = ctx.store.verifyKey(presented, { countFailure });
    if (auth === undefined) {
      ctx.failedAuthLimiter.record(byAddress);
      ctx.failedAuthLimiter.record(byClaim);
      throw unauthenticated('that key is not valid');
    }

    const verdict = ctx.agentLimiter.check(auth.agent.id);
    if (!verdict.allowed) {
      throw new HttpError('rate_limited', 'too many requests', {
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }

    agents.set(request, auth);
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Session, then CSRF on anything that changes state. The order matters: an
 * expired session is `unauthenticated` regardless of the token it carried, so
 * the UI logs out rather than retrying with a fresh token it cannot get.
 *
 * Bearer routes are exempt because a bearer token is not sent by the browser
 * on a cross-origin request; the cookie is.
 */
export function authenticateHuman(ctx: AppContext) {
  return async function adminGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined || token === '') throw unauthenticated('a session is required');

    const session = ctx.store.verifySession(token);
    if (session === undefined) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      throw unauthenticated('the session has expired or been ended');
    }
    sessions.set(request, { ...session, token });

    if (SAFE_METHODS.has(request.method)) return;
    const presented = request.headers[CSRF_HEADER];
    if (typeof presented !== 'string' || !constantTimeEquals(presented, csrfTokenFor(token))) {
      throw csrfRefused('X-CSRF-Token is missing or does not match this session');
    }
  };
}
