import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ReadStreamArgs } from '../../store/index.js';
import type { AttachmentId, Identity, MessageId, MessagePage, StreamPage } from '../../types.js';
import { authenticateAgent, requireAgent } from '../auth.js';
import type { AppContext } from '../context.js';
import { submitPost } from '../post.js';
import {
  asConversationId,
  asIdempotencyKey,
  asSpaceId,
  AgentsQuery,
  AnnotationActionBody,
  EscalateBody,
  parse,
  PostBody,
  PinBody,
  RangeQuery,
  rangeFromQuery,
  readFromQuery,
  StreamQuery,
} from '../validation.js';
import { sendAttachment } from './attachment.js';

/**
 * The stream sequence never reaches an agent: it counts every space's
 * activity, so two of them measure what happens behind the visibility
 * boundary (ADR-0002). The renderer puts it on every message for the admin
 * surfaces; these take it off again on the way out.
 */
function withoutSeq<T extends { readonly seq?: number | undefined }>(item: T): Omit<T, 'seq'> {
  const { seq: _seq, ...rest } = item;
  return rest;
}
function pageWithoutSeq(page: MessagePage): MessagePage {
  return { ...page, messages: page.messages.map(withoutSeq) };
}
function streamWithoutSeq(page: StreamPage): StreamPage {
  return {
    ...page,
    items: page.items.map((item) => (item.kind === 'message' ? withoutSeq(item) : item)),
  };
}

/** The agent API. Bearer only, and no CSRF: a bearer token is not a cookie. */
export function agentRoutes(ctx: AppContext): FastifyPluginAsync {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', authenticateAgent(ctx));

    app.get('/identity', async (request) => {
      const self = requireAgent(request);
      const lastReadCursor = ctx.store.lastReadCursor(self.id);
      const identity: Identity = {
        self: { id: self.id, displayName: self.displayName },
        spaces: ctx.store.listSpacesForAgent(self.id).map((space) => {
          const description = ctx.store.getSpaceDescription(space.id);
          const note = ctx.store.getMembershipNote(self.id, space.id);
          return {
            ...space,
            ...(description === undefined ? {} : { description }),
            ...(note === undefined ? {} : { note }),
          };
        }),
        limits: ctx.limits,
        ...(lastReadCursor === undefined ? {} : { lastReadCursor }),
        reservedSequence: ctx.store.reservedSequence,
      };
      return identity;
    });

    /**
     * The long poll. Read once so anything already waiting returns
     * immediately, and only then wait — on a signal from the process's own
     * writers rather than a timer that re-queries, since one process holds
     * every writer (ADR-0008).
     *
     * Both reads are recorded in the read log, because both happened.
     */
    app.get('/stream', async (request, reply) => {
      const self = requireAgent(request);
      const query = parse(StreamQuery, request.query, 'query');
      const from = readFromQuery(query);
      const limit = ctx.pageLimit(query.limit);
      const waitSeconds = Math.min(query.waitSeconds ?? 0, ctx.limits.maxWaitSeconds);

      const args: ReadStreamArgs = { ...(from === undefined ? {} : { from }), limit };
      let page = ctx.store.readStream(self.id, args);
      if (page.items.length > 0 || waitSeconds === 0) return streamWithoutSeq(page);

      const gone = new AbortController();
      // `close` on the response fires when the socket goes, whether or not we
      // wrote anything; `writableFinished` tells the two apart.
      const onClose = (): void => {
        if (!reply.raw.writableFinished) gone.abort();
      };
      reply.raw.on('close', onClose);
      try {
        await ctx.writes.agent.wait(waitSeconds * 1000, gone.signal);
      } finally {
        reply.raw.off('close', onClose);
      }

      // Nobody is listening: do not spend a second read, or a read-log row, on
      // an answer that goes nowhere.
      if (gone.signal.aborted) return streamWithoutSeq(page);
      return streamWithoutSeq(
        ctx.store.readStream(self.id, { from: { after: page.nextCursor }, limit }),
      );
    });

    app.get('/conversations/:id/messages', async (request) => {
      const self = requireAgent(request);
      const { id } = request.params as { id: string };
      const query = parse(RangeQuery, request.query, 'query');
      return pageWithoutSeq(
        ctx.store.readConversation(
          { kind: 'agent', id: self.id },
          asConversationId(id),
          rangeFromQuery(query),
          ctx.pageLimit(query.limit),
        ),
      );
    });

    app.get('/spaces/:id/messages', async (request) => {
      const self = requireAgent(request);
      const { id } = request.params as { id: string };
      const query = parse(RangeQuery, request.query, 'query');
      return pageWithoutSeq(
        ctx.store.readSpace(
          { kind: 'agent', id: self.id },
          asSpaceId(id),
          rangeFromQuery(query),
          ctx.pageLimit(query.limit),
        ),
      );
    });

    app.get('/agents', async (request) => {
      const self = requireAgent(request);
      const query = parse(AgentsQuery, request.query, 'query');
      const space = query.space === undefined ? undefined : asSpaceId(query.space);
      return ctx.store.listAgentsSharingSpaceWith(self.id, space).map((agent) => {
        const description = ctx.store.getAgentDescription(agent.id);
        const note = space === undefined ? undefined : ctx.store.getMembershipNote(agent.id, space);
        return {
          ...agent,
          ...(description === undefined ? {} : { description }),
          ...(note === undefined ? {} : { note }),
        };
      });
    });

    app.post('/messages', async (request) => {
      const self = requireAgent(request);
      const result = await submitPost(ctx, request, PostBody, { kind: 'agent', id: self.id });
      return { ...result, message: withoutSeq(result.message) };
    });

    const action = (
      kind: 'complete' | 'reopen' | 'unpin',
      run: (self: ReturnType<typeof requireAgent>, conversation: string, key: string) => boolean,
    ) => {
      app.post(`/conversations/:id/${kind}`, async (request) => {
        const self = requireAgent(request);
        const { id } = request.params as { id: string };
        const body = parse(AnnotationActionBody, request.body, 'request body');
        const changed = run(self, id, body.idempotencyKey);
        if (changed) ctx.writes.adminOnly();
        return ctx.store.getConversationAnnotations(asConversationId(id));
      });
    };
    action('complete', (self, id, key) =>
      ctx.store.completeConversation(
        { kind: 'agent', id: self.id },
        asConversationId(id),
        asIdempotencyKey(key),
      ),
    );
    action('reopen', (self, id, key) =>
      ctx.store.reopenConversation(
        { kind: 'agent', id: self.id },
        asConversationId(id),
        asIdempotencyKey(key),
      ),
    );
    action('unpin', (self, id, key) =>
      ctx.store.unpinConversation(
        { kind: 'agent', id: self.id },
        asConversationId(id),
        asIdempotencyKey(key),
      ),
    );
    app.post('/conversations/:id/pin', async (request) => {
      const self = requireAgent(request);
      const { id } = request.params as { id: string };
      const body = parse(PinBody, request.body, 'request body');
      const changed = ctx.store.pinMessage(
        { kind: 'agent', id: self.id },
        asConversationId(id),
        body.messageId as MessageId,
        asIdempotencyKey(body.idempotencyKey),
      );
      if (changed) ctx.writes.adminOnly();
      return ctx.store.getConversationAnnotations(asConversationId(id));
    });

    app.get('/attachments/:id', async (request, reply) => {
      const self = requireAgent(request);
      const { id } = request.params as { id: string };
      return sendAttachment(ctx, { kind: 'agent', id: self.id }, id as AttachmentId, reply);
    });

    app.post('/escalations', async (request, reply) => {
      const self = requireAgent(request);
      const payload = parse(EscalateBody, request.body, 'request body');
      const outcome = ctx.store.recordEscalation({
        agent: self.id,
        conversation: asConversationId(payload.conversation),
        reason: payload.reason,
        idempotencyKey: asIdempotencyKey(payload.idempotencyKey),
      });
      // The human's screens hear about it now; agent streams never do — an
      // escalation is invisible to agents, and waking their polls for it
      // would write read-log rows for reads nobody wanted. A replay recorded
      // nothing, so it wakes nobody.
      if (outcome.created) ctx.writes.adminOnly();
      // Recorded, not delivered: notification drains separately and durably,
      // and its outcome is the human's to see, not the agent's.
      return reply.code(204).send();
    });
  };
}
