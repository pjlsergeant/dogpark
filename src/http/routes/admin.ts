import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AgentRecord } from '../../store/index.js';
import type { Agent, AttachmentId } from '../../types.js';
import { authenticateHuman, csrfTokenFor, requireSession, SESSION_COOKIE } from '../auth.js';
import type { AppContext } from '../context.js';
import { invalid, notFound, unauthenticated } from '../errors.js';
import { verifyPassword } from '../password.js';
import { assertBodyFits, collectPost } from '../post.js';
import {
  adminAgent,
  bare,
  escalationRow,
  keySummary,
  readLogRow,
  searchRow,
  spaceMembers,
} from '../shapes.js';
import {
  AdminAgentsQuery,
  asAgentId,
  asConversationId,
  asSpaceId,
  EscalationsQuery,
  HumanPostBody,
  isTruthyFlag,
  KeyBody,
  NameBody,
  parse,
  PasswordBody,
  RangeQuery,
  rangeFromQuery,
  ReadLogQuery,
  SearchQuery,
} from '../validation.js';
import { sendAttachment } from './attachment.js';

const HUMAN = { kind: 'human' } as const;

export function adminRoutes(ctx: AppContext): FastifyPluginAsync {
  const pageLimit = (asked: number | undefined): number =>
    Math.min(asked ?? ctx.limits.maxPageSize, ctx.limits.maxPageSize);

  const agentOr404 = (id: string): AgentRecord => {
    const record = ctx.store.getAgent(asAgentId(id));
    if (record === undefined) throw notFound('agent');
    return record;
  };

  const withKeys = (record: AgentRecord): unknown =>
    adminAgent(record, ctx.store.listKeys(record.id));

  return async function routes(app: FastifyInstance): Promise<void> {
    // -----------------------------------------------------------------------
    // Session. The only admin route reachable without one.
    // -----------------------------------------------------------------------

    app.post('/session', async (request, reply) => {
      // Not an agent, so not covered by requestsPerMinute. Limited by source
      // address instead: a password is the one credential worth guessing.
      const verdict = ctx.loginLimiter.check(request.ip);
      if (!verdict.allowed) throw unauthenticated('too many attempts; wait and try again');

      const { password } = parse(PasswordBody, request.body, 'request body');
      if (!verifyPassword(ctx.config.DOGPARK_PASSWORD_HASH, password)) {
        throw unauthenticated('that password is not correct');
      }

      // Expiry is enforced on every lookup; this only keeps the table from
      // growing without bound.
      ctx.store.deleteExpiredSessions();
      const session = ctx.store.createSession(ctx.sessionTtlSeconds);
      reply.setCookie(SESSION_COOKIE, session.token, {
        httpOnly: true,
        secure: ctx.secureCookies,
        sameSite: 'lax',
        path: '/',
        maxAge: ctx.sessionTtlSeconds,
      });
      return {
        csrfToken: csrfTokenFor(session.token),
        displayName: ctx.config.DOGPARK_DISPLAY_NAME,
        expiresAt: session.expiresAt,
      };
    });

    await app.register(async (guarded: FastifyInstance) => {
      guarded.addHook('onRequest', authenticateHuman(ctx));

      /**
       * Not in the contract. A reload keeps the `HttpOnly` cookie but loses
       * the CSRF token, which lives only in the page; without this the human
       * logs in again on every refresh. Adding a route the contract does not
       * name is a smaller thing than that.
       */
      guarded.get('/session', async (request) => {
        const session = requireSession(request);
        return {
          csrfToken: csrfTokenFor(session.token),
          displayName: ctx.config.DOGPARK_DISPLAY_NAME,
          expiresAt: session.expiresAt,
        };
      });

      guarded.delete('/session', async (request, reply) => {
        // Server-side: the row goes, so the cookie is worthless even if it is
        // still in a browser somewhere.
        ctx.store.deleteSession(requireSession(request).token);
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.code(204).send();
      });

      // ---------------------------------------------------------------------
      // Spaces and membership
      // ---------------------------------------------------------------------

      guarded.get('/spaces', async () => ctx.store.listSpaces());

      guarded.post('/spaces', async (request, reply) => {
        const { name } = parse(NameBody, request.body, 'request body');
        return reply.code(201).send(ctx.store.createSpace(name));
      });

      guarded.patch('/spaces/:id', async (request) => {
        const { id } = request.params as { id: string };
        const { name } = parse(NameBody, request.body, 'request body');
        return ctx.store.renameSpace(asSpaceId(id), name);
      });

      guarded.get('/spaces/:id/members', async (request) => {
        const { id } = request.params as { id: string };
        if (ctx.store.getSpace(asSpaceId(id)) === undefined) throw notFound('space');
        return spaceMembers(ctx.store, asSpaceId(id));
      });

      guarded.put('/spaces/:id/members/:agentId', async (request, reply) => {
        const { id, agentId } = request.params as { id: string; agentId: string };
        // A grant appends a system event to the agent's stream, so anyone
        // waiting on one should hear about it now rather than at their timeout.
        if (ctx.store.grantMembership(asAgentId(agentId), asSpaceId(id))) ctx.writes.notify();
        return reply.code(204).send();
      });

      guarded.delete('/spaces/:id/members/:agentId', async (request, reply) => {
        const { id, agentId } = request.params as { id: string; agentId: string };
        if (ctx.store.revokeMembership(asAgentId(agentId), asSpaceId(id))) ctx.writes.notify();
        return reply.code(204).send();
      });

      // ---------------------------------------------------------------------
      // Agents and keys
      // ---------------------------------------------------------------------

      guarded.get('/agents', async (request) => {
        const query = parse(AdminAgentsQuery, request.query, 'query');
        return ctx.store
          .listAgents({ includeArchived: isTruthyFlag(query.includeArchived) })
          .map(withKeys);
      });

      guarded.post('/agents', async (request, reply) => {
        const { name } = parse(NameBody, request.body, 'request body');
        const record = ctx.store.createAgent(name);
        const issued = ctx.store.issueKey(record.id);
        // The only time the key exists. Nothing stores it; only its hash.
        return reply.code(201).send({ agent: bare(record), keyId: issued.id, key: issued.key });
      });

      guarded.patch('/agents/:id', async (request) => {
        const { id } = request.params as { id: string };
        const { name } = parse(NameBody, request.body, 'request body');
        return withKeys(ctx.store.renameAgent(asAgentId(id), name));
      });

      guarded.get('/agents/:id/keys', async (request) => {
        // A key that cannot be named cannot be revoked, and the plaintext is
        // shown once — so the list is ids and dates, never material.
        const { id } = request.params as { id: string };
        const record = agentOr404(id);
        return ctx.store.listKeys(record.id).map(keySummary);
      });

      guarded.post('/agents/:id/keys', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { label } = parse(KeyBody, request.body ?? {}, 'request body');
        const record = agentOr404(id);
        const issued = ctx.store.issueKey(record.id, label);
        return reply.code(201).send({ keyId: issued.id, key: issued.key, agent: bare(record) });
      });

      guarded.delete('/agents/:id/keys/:keyId', async (request, reply) => {
        const { id, keyId } = request.params as { id: string; keyId: string };
        const record = agentOr404(id);
        // Revoking by id alone would let a mistyped agent revoke someone
        // else's key, and would answer "does this key id exist?" for free.
        const key = ctx.store.listKeys(record.id).find((candidate) => candidate.id === keyId);
        if (key === undefined) throw notFound('key');
        ctx.store.revokeKey(keyId);
        return reply.code(204).send();
      });

      guarded.post('/agents/:id/archive', async (request) => {
        const { id } = request.params as { id: string };
        return withKeys(ctx.store.archiveAgent(asAgentId(id)));
      });

      guarded.post('/agents/:id/unarchive', async (request) => {
        const { id } = request.params as { id: string };
        // The store deliberately issues no key here: a hashed one cannot be
        // shown again, so the fresh key is a separate, visible step.
        const record = ctx.store.unarchiveAgent(asAgentId(id));
        const issued = ctx.store.issueKey(record.id);
        return { agent: bare(record), keyId: issued.id, key: issued.key };
      });

      // ---------------------------------------------------------------------
      // Reading and posting
      // ---------------------------------------------------------------------

      guarded.get('/spaces/:id/conversations', async (request) => {
        const { id } = request.params as { id: string };
        return ctx.store.listConversations(asSpaceId(id));
      });

      guarded.get('/conversations/:id/messages', async (request) => {
        const { id } = request.params as { id: string };
        const query = parse(RangeQuery, request.query, 'query');
        return ctx.store.readConversation(
          HUMAN,
          asConversationId(id),
          rangeFromQuery(query),
          pageLimit(query.limit),
        );
      });

      guarded.post('/messages', async (request) => {
        const collected = await collectPost(ctx, request, HumanPostBody);
        const { payload } = collected;
        try {
          assertBodyFits(payload.body, ctx.limits.maxMessageBytes);

          // Attachment ids are minted per request, so they are left out of the
          // replay hash: a retry uploading the same file is the same request.
          const shape = {
            target: payload.target,
            body: payload.body,
            files: collected.attachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              sizeBytes: a.sizeBytes,
            })),
          };
          if (payload.idempotencyKey !== undefined) {
            const replay = ctx.humanPosts.lookup(payload.idempotencyKey, shape);
            if (replay !== undefined) {
              await collected.discard();
              return replay;
            }
          }

          const result = ctx.store.postMessage({
            sender: HUMAN,
            target:
              'conversation' in payload.target
                ? { conversation: asConversationId(payload.target.conversation) }
                : { space: asSpaceId(payload.target.space), title: payload.target.title },
            body: payload.body,
            ...(collected.attachments.length === 0 ? {} : { attachments: collected.attachments }),
          });
          ctx.writes.notify();

          const posted = { message: result.message, conversation: result.conversation };
          if (payload.idempotencyKey !== undefined) {
            ctx.humanPosts.remember(payload.idempotencyKey, shape, posted);
          }
          return posted;
        } catch (error) {
          await collected.discard();
          throw error;
        }
      });

      guarded.get('/attachments/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        return sendAttachment(ctx, HUMAN, id as AttachmentId, reply);
      });

      // ---------------------------------------------------------------------
      // Forensics
      // ---------------------------------------------------------------------

      guarded.get('/reads', async (request) => {
        const query = parse(ReadLogQuery, request.query, 'query');
        // The store filters the read log by agent and nothing else. Ranging or
        // paging it here would mean fetching a window and trimming it, which
        // in the one view whose whole job is completeness would silently drop
        // rows. Refused until the store can do it. Reported.
        for (const [name, value] of Object.entries({
          since: query.since,
          until: query.until,
          after: query.after,
        })) {
          if (value !== undefined) {
            throw invalid(`the read log cannot be filtered by ${name} yet`);
          }
        }

        const limit = pageLimit(query.limit);
        const cache = new Map<string, Agent>();
        const rows = ctx.store.listReadLog({
          ...(query.agent === undefined ? {} : { agent: asAgentId(query.agent) }),
          // One more than asked for, so `hasMore` is observed rather than
          // guessed.
          limit: limit + 1,
        });
        return {
          reads: rows.slice(0, limit).map((entry) => readLogRow(ctx.store, cache, entry)),
          // Null, not a token: there is nothing to resume from until the store
          // offers a cursor over this table.
          nextCursor: null,
          hasMore: rows.length > limit,
        };
      });

      guarded.get('/escalations', async (request) => {
        const query = parse(EscalationsQuery, request.query, 'query');
        const cache = new Map<string, Agent>();
        return ctx.store
          .listEscalations({ limit: pageLimit(query.limit) })
          .map((record) => escalationRow(ctx.store, cache, record));
      });

      guarded.get('/search', async (request) => {
        const query = parse(SearchQuery, request.query, 'query');
        // FTS5 parses `q` itself and rejects malformed syntax with an opaque
        // SQLite error. That is the human's typo, not a server fault.
        try {
          return ctx.store
            .searchMessages(query.q, {
              ...(query.space === undefined ? {} : { space: asSpaceId(query.space) }),
              limit: pageLimit(query.limit),
            })
            .map((hit) => searchRow(ctx.store, hit));
        } catch (error) {
          if (isSqliteError(error)) throw invalid(`search query is not valid FTS5 syntax`);
          throw error;
        }
      });
    });
  };
}

function isSqliteError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE')
  );
}
