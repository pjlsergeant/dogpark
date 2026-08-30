import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ReadStreamArgs } from '../../store/index.js';
import type { AttachmentId, Identity } from '../../types.js';
import { authenticateAgent, requireAgent } from '../auth.js';
import type { AppContext } from '../context.js';
import { submitPost } from '../post.js';
import {
  asConversationId,
  asIdempotencyKey,
  asSpaceId,
  AgentsQuery,
  EscalateBody,
  parse,
  PostBody,
  RangeQuery,
  rangeFromQuery,
  readFromQuery,
  StreamQuery,
} from '../validation.js';
import { sendAttachment } from './attachment.js';

/** The agent API. Bearer only, and no CSRF: a bearer token is not a cookie. */
export function agentRoutes(ctx: AppContext): FastifyPluginAsync {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', authenticateAgent(ctx));

    app.get('/identity', async (request) => {
      const self = requireAgent(request).agent;
      const lastReadCursor = ctx.store.lastReadCursor(self.id);
      const identity: Identity = {
        self: { id: self.id, displayName: self.displayName },
        spaces: ctx.store.listSpacesForAgent(self.id),
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
      const self = requireAgent(request).agent;
      const query = parse(StreamQuery, request.query, 'query');
      const from = readFromQuery(query);
      const limit = ctx.pageLimit(query.limit);
      const waitSeconds = Math.min(query.waitSeconds ?? 0, ctx.limits.maxWaitSeconds);

      const args: ReadStreamArgs = { ...(from === undefined ? {} : { from }), limit };
      let page = ctx.store.readStream(self.id, args);
      if (page.items.length > 0 || waitSeconds === 0) return page;

      const gone = new AbortController();
      // `close` on the response fires when the socket goes, whether or not we
      // wrote anything; `writableFinished` tells the two apart.
      const onClose = (): void => {
        if (!reply.raw.writableFinished) gone.abort();
      };
      reply.raw.on('close', onClose);
      try {
        await ctx.writes.wait(waitSeconds * 1000, gone.signal);
      } finally {
        reply.raw.off('close', onClose);
      }

      // Nobody is listening: do not spend a second read, or a read-log row, on
      // an answer that goes nowhere.
      if (gone.signal.aborted) return page;
      return ctx.store.readStream(self.id, { from: { after: page.nextCursor }, limit });
    });

    app.get('/conversations/:id/messages', async (request) => {
      const self = requireAgent(request).agent;
      const { id } = request.params as { id: string };
      const query = parse(RangeQuery, request.query, 'query');
      return ctx.store.readConversation(
        { kind: 'agent', id: self.id },
        asConversationId(id),
        rangeFromQuery(query),
        ctx.pageLimit(query.limit),
      );
    });

    app.get('/spaces/:id/messages', async (request) => {
      const self = requireAgent(request).agent;
      const { id } = request.params as { id: string };
      const query = parse(RangeQuery, request.query, 'query');
      return ctx.store.readSpace(
        { kind: 'agent', id: self.id },
        asSpaceId(id),
        rangeFromQuery(query),
        ctx.pageLimit(query.limit),
      );
    });

    app.get('/agents', async (request) => {
      const self = requireAgent(request).agent;
      const query = parse(AgentsQuery, request.query, 'query');
      return ctx.store.listAgentsSharingSpaceWith(
        self.id,
        query.space === undefined ? undefined : asSpaceId(query.space),
      );
    });

    app.post('/messages', async (request) => {
      const self = requireAgent(request).agent;
      return submitPost(ctx, request, PostBody, { kind: 'agent', id: self.id });
    });

    app.get('/attachments/:id', async (request, reply) => {
      const self = requireAgent(request).agent;
      const { id } = request.params as { id: string };
      return sendAttachment(ctx, { kind: 'agent', id: self.id }, id as AttachmentId, reply);
    });

    app.post('/escalations', async (request, reply) => {
      const self = requireAgent(request).agent;
      const payload = parse(EscalateBody, request.body, 'request body');
      ctx.store.recordEscalation({
        agent: self.id,
        conversation: asConversationId(payload.conversation),
        reason: payload.reason,
        idempotencyKey: asIdempotencyKey(payload.idempotencyKey),
      });
      // Recorded, not delivered: notification drains separately and durably,
      // and its outcome is the human's to see, not the agent's.
      return reply.code(204).send();
    });
  };
}
