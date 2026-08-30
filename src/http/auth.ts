import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
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

export function rememberSession(request: FastifyRequest, session: ActiveSession): void {
  sessions.set(request, session);
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

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The id in the middle of `dgp_<agent-id>_<secret>`, which travels in the clear
 * by design so that a rejected authentication is still attributable (see
 * `parseKey` in the store). Read here — never verified here — so a refused
 * attempt can be counted against the id it claimed without hashing anything.
 *
 * A token in no recognisable shape claims nothing, and every such attempt
 * shares one bucket.
 */
function claimedAgentId(presented: string): string {
  const parts = presented.split('_');
  const [prefix, agent, secret] = parts;
  if (parts.length !== 3 || prefix !== 'dgp' || agent === undefined || !secret) return '';
  return agent;
}

/**
 * Bearer authentication, then this agent's share of `requestsPerMinute`.
 *
 * Failed authentication is limited *before* verification, because verification
 * is the cost: a SHA-256 over the presented key on the event loop, and a bump
 * of `failed_auth_attempts` against the id the key claimed. Every agent id is
 * public — it is the middle of every key, and any agent can list its peers —
 * so without this anyone who can reach the port can make a healthy agent look
 * broken, for free and without limit.
 *
 * Two buckets, and a refusal needs *both* to be exhausted. Either alone is a
 * lockout waiting to happen: the claimed id is attacker-supplied, so gating on
 * it alone would let anyone shut a named agent out; the source address is
 * shared by every agent on one host, so gating on it alone would let one agent
 * with a stale key shut out its neighbours. Requiring both means a flood is
 * stopped where it comes from, while an agent whose own key verifies — and so
 * has spent nothing from either bucket — is never caught in it.
 *
 * Only failures are charged. A valid key costs nothing here and is limited by
 * `requestsPerMinute` like every other agent call.
 */
export function authenticateAgent(ctx: AppContext) {
  return async function agentGuard(request: FastifyRequest): Promise<void> {
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined) {
      throw unauthenticated('expected an Authorization: Bearer dgp_… header');
    }

    const byAddress = `ip:${request.ip}`;
    const byClaim = `id:${claimedAgentId(presented)}`;
    const address = ctx.failedAuthLimiter.peek(byAddress);
    const claim = ctx.failedAuthLimiter.peek(byClaim);
    if (!address.allowed && !claim.allowed) {
      throw new HttpError('rate_limited', 'too many failed authentication attempts', {
        retryAfterSeconds: Math.max(address.retryAfterSeconds, claim.retryAfterSeconds),
      });
    }

    // The store counts a rejected attempt against the id the key claimed, so
    // a bad key is still attributable.
    const auth = ctx.store.verifyKey(presented);
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
    if (typeof presented !== 'string' || !equals(presented, csrfTokenFor(token))) {
      throw csrfRefused('X-CSRF-Token is missing or does not match this session');
    }
  };
}
