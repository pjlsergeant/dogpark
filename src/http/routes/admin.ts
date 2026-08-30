import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AgentRecord } from '../../store/index.js';
import type { Agent, AttachmentId } from '../../types.js';
import { authenticateHuman, csrfTokenFor, requireSession, SESSION_COOKIE } from '../auth.js';
import type { AppContext } from '../context.js';
import { notFound, unauthenticated } from '../errors.js';
import { verifyPassword } from '../password.js';
import { submitPost } from '../post.js';
import {
  adminAgent,
  bare,
  conversationRow,
  escalationRow,
  keySummary,
  readLogRow,
  searchRow,
  spaceMembers,
} from '../shapes.js';
import {
  asAgentId,
  asConversationId,
  asMessageId,
  asReadLogCursor,
  asSpaceId,
  asTimestamp,
  EscalationsQuery,
  HumanPostBody,
  KeyBody,
  NameBody,
  parse,
  PasswordBody,
  RangeQuery,
  rangeFromQuery,
  ReadLogQuery,
  SearchQuery,
  TitleBody,
} from '../validation.js';
import { sendAttachment } from './attachment.js';

const HUMAN = { kind: 'human' } as const;

export function adminRoutes(ctx: AppContext): FastifyPluginAsync {
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
       * A reload keeps the `HttpOnly` cookie but loses the CSRF token, which
       * lives only in the page; without this the human logs in every refresh.
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

      // Titles are mutable and references are what get stored (ADR-0014), so
      // a rename moves no message and breaks no mention.
      guarded.patch('/conversations/:id', async (request) => {
        const { id } = request.params as { id: string };
        const { title } = parse(TitleBody, request.body, 'request body');
        return ctx.store.renameConversation(asConversationId(id), title);
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

      // The whole roster, archived included: an archived agent is not retired
      // and can be brought back (ADR-0013), so the human's list has to show
      // one. The UI hides them behind a toggle.
      guarded.get('/agents', async () => {
        return ctx.store.listAgents({ includeArchived: true }).map(withKeys);
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
        // A hashed key cannot be re-shown, so the agent comes back with a new one.
        const record = ctx.store.unarchiveAgent(asAgentId(id));
        const issued = ctx.store.issueKey(record.id);
        return { agent: bare(record), keyId: issued.id, key: issued.key };
      });

      // ---------------------------------------------------------------------
      // Reading and posting
      // ---------------------------------------------------------------------

      /**
       * The thread list, with what a list needs to be scannable: how many
       * messages, when the last one landed and who wrote it. Derived by the
       * store in one grouped query — folding it here would mean reading every
       * message in the space per request.
       */
      guarded.get('/spaces/:id/conversations', async (request) => {
        const { id } = request.params as { id: string };
        return ctx.store.listConversationSummaries(asSpaceId(id)).map(conversationRow);
      });

      guarded.get('/conversations/:id/messages', async (request) => {
        const { id } = request.params as { id: string };
        const query = parse(RangeQuery, request.query, 'query');
        return ctx.store.readConversation(
          HUMAN,
          asConversationId(id),
          rangeFromQuery(query),
          ctx.pageLimit(query.limit),
        );
      });

      guarded.post('/messages', async (request) => submitPost(ctx, request, HumanPostBody, HUMAN));

      guarded.get('/attachments/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        return sendAttachment(ctx, HUMAN, id as AttachmentId, reply);
      });

      // ---------------------------------------------------------------------
      // Forensics
      // ---------------------------------------------------------------------

      /**
       * The read log: the fastest-growing table here, and the forensic view.
       * Every filter is the store's — keyset paging over `(read_at, rowid)`,
       * bounded by `since` and `until` — so a page is never a window fetched
       * here and trimmed, which in the one view whose whole job is
       * completeness would silently drop rows.
       *
       * `after` arrives opaque and goes back unread. A malformed one is the
       * store's `invalid_request`, like a malformed timestamp.
       */
      guarded.get('/reads', async (request) => {
        const query = parse(ReadLogQuery, request.query, 'query');
        const cache = new Map<string, Agent>();
        const page = ctx.store.readReadLog({
          ...(query.agent === undefined ? {} : { agent: asAgentId(query.agent) }),
          ...(query.since === undefined ? {} : { since: asTimestamp(query.since) }),
          ...(query.until === undefined ? {} : { until: asTimestamp(query.until) }),
          ...(query.after === undefined ? {} : { after: asReadLogCursor(query.after) }),
          limit: ctx.pageLimit(query.limit),
        });
        return {
          reads: page.entries.map((entry) => readLogRow(ctx.store, cache, entry)),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      });

      /**
       * One message with the labels in force when a read-log row was written
       * (`Store.renderAsOfRead`). A label snapshot only: whether the message
       * was on that page is not checked here — the row's kind, parameters and
       * cursor answer that. Either id unknown is `not_found`.
       */
      guarded.get('/reads/:id/messages/:messageId', async (request) => {
        const { id, messageId } = request.params as { id: string; messageId: string };
        const rendered = ctx.store.renderAsOfRead(asMessageId(messageId), id);
        if (rendered === undefined) throw notFound('read or message');
        return rendered;
      });

      guarded.get('/escalations', async (request) => {
        const query = parse(EscalationsQuery, request.query, 'query');
        const cache = new Map<string, Agent>();
        return ctx.store
          .listEscalations({ limit: ctx.pageLimit(query.limit) })
          .map((record) => escalationRow(ctx.store, cache, record));
      });

      // The store turns FTS5's own parse failure into `invalid_request` — the
      // human's typo, not a server fault — so nothing is caught here.
      guarded.get('/search', async (request) => {
        const query = parse(SearchQuery, request.query, 'query');
        return ctx.store
          .searchMessages(query.q, {
            ...(query.space === undefined ? {} : { space: asSpaceId(query.space) }),
            limit: ctx.pageLimit(query.limit),
          })
          .map((hit) => searchRow(ctx.store, hit));
      });
    });
  };
}
