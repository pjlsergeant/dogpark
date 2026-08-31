import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AgentRecord } from '../../store/index.js';
import type { AdminAgent, Agent, AttachmentId, MessageId, SpaceSummary } from '../../types.js';
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
  readLogRow,
  searchRow,
  spaceMembers,
} from '../shapes.js';
import {
  asAgentId,
  asConversationId,
  asEscalationCursor,
  asIdempotencyKey,
  asReadLogCursor,
  asSearchCursor,
  asSpaceId,
  asTimestamp,
  ChangesQuery,
  DescriptionBody,
  EscalationsQuery,
  HumanPostBody,
  HumanAnnotationActionBody,
  HumanPinBody,
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

  const withKeys = (record: AgentRecord): AdminAgent =>
    adminAgent(record, ctx.store.listKeys(record.id), ctx.store.getAgentDescription(record.id));

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
      if (!(await verifyPassword(ctx.config.DOGPARK_PASSWORD_HASH, password))) {
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

      guarded.get('/spaces', async (): Promise<readonly SpaceSummary[]> =>
        ctx.store.listSpaceSummaries().map((space) => {
          const description = ctx.store.getSpaceDescription(space.id);
          return { ...space, ...(description === undefined ? {} : { description }) };
        }),
      );

      /**
       * The human's long poll. A version that moves on every mutation the
       * UI can show — posts and membership like the agent stream, but also
       * renames, roster and key changes, and escalations, which agents are
       * never woken for — so the UI can hold one of these open and refresh
       * what it shows when it returns, rather than asking on a timer.
       * `after` is the version last seen: a write that landed between two
       * requests answers the next one at once, and a restart reads as a
       * change (the version carries a per-process epoch), which it may as
       * well be. Without `after` or a wait it simply reports the version.
       */
      guarded.get('/changes', async (request, reply) => {
        const query = parse(ChangesQuery, request.query, 'query');
        const waitSeconds = Math.min(query.waitSeconds ?? 0, ctx.limits.maxWaitSeconds);
        const current = ctx.writes.admin.version;
        if (query.after === undefined || query.after !== current || waitSeconds === 0) {
          return { version: current };
        }
        const gone = new AbortController();
        const onClose = (): void => {
          if (!reply.raw.writableFinished) gone.abort();
        };
        reply.raw.on('close', onClose);
        try {
          await ctx.writes.admin.wait(waitSeconds * 1000, gone.signal);
        } finally {
          reply.raw.off('close', onClose);
        }
        return { version: ctx.writes.admin.version };
      });

      guarded.post('/spaces', async (request, reply) => {
        const { name } = parse(NameBody, request.body, 'request body');
        const space = ctx.store.createSpace(name);
        ctx.writes.adminOnly();
        return reply.code(201).send(space);
      });

      guarded.patch('/spaces/:id', async (request) => {
        const { id } = request.params as { id: string };
        const { name } = parse(NameBody, request.body, 'request body');
        const space = ctx.store.renameSpace(asSpaceId(id), name);
        ctx.writes.adminOnly();
        return space;
      });

      guarded.put('/spaces/:id/description', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { description } = parse(DescriptionBody, request.body, 'request body');
        ctx.store.setSpaceDescription(asSpaceId(id), description);
        ctx.writes.adminOnly();
        return reply.code(204).send();
      });

      // Titles are mutable and references are what get stored (ADR-0014), so
      // a rename moves no message and breaks no mention.
      guarded.patch('/conversations/:id', async (request) => {
        const { id } = request.params as { id: string };
        const { title } = parse(TitleBody, request.body, 'request body');
        const conversation = ctx.store.renameConversation(asConversationId(id), title);
        ctx.writes.adminOnly();
        return conversation;
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
        if (ctx.store.grantMembership(asAgentId(agentId), asSpaceId(id))) ctx.writes.agentVisible();
        return reply.code(204).send();
      });

      guarded.delete('/spaces/:id/members/:agentId', async (request, reply) => {
        const { id, agentId } = request.params as { id: string; agentId: string };
        if (ctx.store.revokeMembership(asAgentId(agentId), asSpaceId(id)))
          ctx.writes.agentVisible();
        return reply.code(204).send();
      });

      guarded.put('/spaces/:id/members/:agentId/note', async (request, reply) => {
        const { id, agentId } = request.params as { id: string; agentId: string };
        const { description } = parse(DescriptionBody, request.body, 'request body');
        ctx.store.setMembershipNote(asAgentId(agentId), asSpaceId(id), description);
        ctx.writes.adminOnly();
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
        ctx.writes.adminOnly();
        // The only time the key exists. Nothing stores it; only its hash.
        return reply.code(201).send({ agent: bare(record), keyId: issued.id, key: issued.key });
      });

      guarded.patch('/agents/:id', async (request) => {
        const { id } = request.params as { id: string };
        const { name } = parse(NameBody, request.body, 'request body');
        const renamed = withKeys(ctx.store.renameAgent(asAgentId(id), name));
        ctx.writes.adminOnly();
        return renamed;
      });

      guarded.put('/agents/:id/description', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { description } = parse(DescriptionBody, request.body, 'request body');
        ctx.store.setAgentDescription(asAgentId(id), description);
        ctx.writes.adminOnly();
        return reply.code(204).send();
      });

      guarded.post('/agents/:id/keys', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { label } = parse(KeyBody, request.body ?? {}, 'request body');
        const record = agentOr404(id);
        const issued = ctx.store.issueKey(record.id, label);
        ctx.writes.adminOnly();
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
        ctx.writes.adminOnly();
        return reply.code(204).send();
      });

      guarded.post('/agents/:id/archive', async (request) => {
        const { id } = request.params as { id: string };
        const archived = withKeys(ctx.store.archiveAgent(asAgentId(id)));
        ctx.writes.adminOnly();
        return archived;
      });

      guarded.post('/agents/:id/unarchive', async (request) => {
        const { id } = request.params as { id: string };
        // A hashed key cannot be re-shown, so the agent comes back with a new one.
        const record = ctx.store.unarchiveAgent(asAgentId(id));
        const issued = ctx.store.issueKey(record.id);
        ctx.writes.adminOnly();
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

      const humanAction = (
        kind: 'complete' | 'reopen' | 'unpin',
        run: (
          conversation: ReturnType<typeof asConversationId>,
          key?: ReturnType<typeof asIdempotencyKey>,
        ) => boolean,
      ) => {
        guarded.post(`/conversations/:id/${kind}`, async (request) => {
          const { id } = request.params as { id: string };
          const body = parse(HumanAnnotationActionBody, request.body ?? {}, 'request body');
          const changed = run(
            asConversationId(id),
            body.idempotencyKey === undefined ? undefined : asIdempotencyKey(body.idempotencyKey),
          );
          if (changed) ctx.writes.adminOnly();
          return ctx.store.getConversationAnnotations(asConversationId(id));
        });
      };
      humanAction('complete', (conversation, key) =>
        ctx.store.completeConversation(HUMAN, conversation, key),
      );
      humanAction('reopen', (conversation, key) =>
        ctx.store.reopenConversation(HUMAN, conversation, key),
      );
      humanAction('unpin', (conversation, key) =>
        ctx.store.unpinConversation(HUMAN, conversation, key),
      );
      guarded.post('/conversations/:id/pin', async (request) => {
        const { id } = request.params as { id: string };
        const body = parse(HumanPinBody, request.body, 'request body');
        const changed = ctx.store.pinMessage(
          HUMAN,
          asConversationId(id),
          body.messageId as MessageId,
          body.idempotencyKey === undefined ? undefined : asIdempotencyKey(body.idempotencyKey),
        );
        if (changed) ctx.writes.adminOnly();
        return ctx.store.getConversationAnnotations(asConversationId(id));
      });

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

      guarded.get('/reads/:id', async (request) => {
        const { id } = request.params as { id: string };
        const entry = ctx.store.getRead(id);
        if (entry === undefined) throw notFound('read');
        return readLogRow(ctx.store, new Map<string, Agent>(), entry);
      });

      /**
       * A conversation as it read at a read-log row: the reader's "as agent X
       * saw it" mode. Paged like the live read; nothing is logged.
       */
      guarded.get('/reads/:id/conversations/:conversationId/messages', async (request) => {
        const { id, conversationId } = request.params as { id: string; conversationId: string };
        const query = parse(RangeQuery, request.query, 'query');
        const page = ctx.store.readConversationAsOf(
          id,
          asConversationId(conversationId),
          rangeFromQuery(query),
          ctx.pageLimit(query.limit),
        );
        if (page === undefined) throw notFound('read or conversation');
        return page;
      });

      /**
       * The inbox, newest first unless asked otherwise, paged like the read
       * log. Both counts are over the whole table, so a badge is right whatever
       * page is showing. `unacknowledged` is the headline — what still wants a
       * human — and `undelivered` is delivery detail beside it. `webhookConfigured`
       * lets the UI drop delivery state entirely: without a webhook it is
       * meaningless noise, since nothing was ever going to be sent.
       */
      guarded.get('/escalations', async (request) => {
        const query = parse(EscalationsQuery, request.query, 'query');
        const cache = new Map<string, Agent>();
        const page = ctx.store.listEscalations({
          order: query.order ?? 'newest',
          ...(query.after === undefined ? {} : { after: asEscalationCursor(query.after) }),
          limit: ctx.pageLimit(query.limit),
        });
        return {
          escalations: page.escalations.map((record) => escalationRow(ctx.store, cache, record)),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          unacknowledged: ctx.store.countUnacknowledgedEscalations(),
          undelivered: ctx.store.countUndeliveredEscalations(),
          webhookConfigured: ctx.config.DOGPARK_WEBHOOK_URL !== undefined,
        };
      });

      /**
       * Settle an escalation: the human has seen it and it drops out of the
       * headline count. Idempotent, so a double-click is harmless, and a
       * change the UI shows, so the badge and the row refresh.
       */
      guarded.post('/escalations/:id/ack', async (request) => {
        const { id } = request.params as { id: string };
        const record = ctx.store.acknowledgeEscalation(id);
        if (record === undefined) throw notFound('escalation');
        ctx.writes.adminOnly();
        return escalationRow(ctx.store, new Map<string, Agent>(), record);
      });

      // The store turns FTS5's own parse failure into `invalid_request` — the
      // human's typo, not a server fault — so nothing is caught here.
      guarded.get('/search', async (request) => {
        const query = parse(SearchQuery, request.query, 'query');
        const page = ctx.store.searchMessages(query.q, {
          ...(query.space === undefined ? {} : { space: asSpaceId(query.space) }),
          ...(query.order === undefined ? {} : { order: query.order }),
          ...(query.after === undefined ? {} : { after: asSearchCursor(query.after) }),
          limit: ctx.pageLimit(query.limit),
        });
        return {
          results: page.hits.map((hit) => searchRow(ctx.store, hit)),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      });
    });
  };
}
