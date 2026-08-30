/**
 * Messages: posting, the stream, the queries, search, and attachments'
 * metadata. Immutable rows (ADR-0004), rendered on read (ADR-0014).
 */
import Database from 'better-sqlite3';
import type {
  AgentId,
  AttachmentId,
  ConversationId,
  MessageId,
  MessagePage,
  Range,
  ReadFrom,
  SpaceId,
  StreamItem,
  StreamPage,
  Timestamp,
} from '../types.js';
import type { ConversationResolver } from './conversations.js';
import type { StoreContext } from './context.js';
import {
  decodeCursor,
  decodeQueryCursor,
  decodeSearchCursor,
  encodeCursor,
  encodeQueryCursor,
  encodeSearchCursor,
} from './cursors.js';
import { invalid, notFound } from './errors.js';
import { constantTimeEquals, requestHash } from './hash.js';
import { newId } from './ids.js';
import { clampLimit } from './limits.js';
import { recordRead } from './read-log.js';
import type {
  PostMessageInput,
  PostMessageResult,
  Reader,
  ReadStreamArgs,
  Store,
} from './records.js';
import { createRenderer } from './render.js';
import type { RenderCache } from './render.js';
import type { ConversationRow, MessageRow, SearchBounds } from './statements.js';
import {
  assertNoReservedSequence,
  assertNonEmpty,
  encodeMentions,
  normalizeTimestamp,
  renderSnippet,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
} from './text.js';

/**
 * Who a write is idempotent for. An agent is its own id; the human is
 * `HUMAN_WRITER`, which carries a character the id alphabet does not. A row
 * hand-written into `agent` could still carry the sentinel, so `writerOf`
 * refuses to write for one (schema.sql, Idempotency).
 */
const HUMAN_WRITER = ':human';

function writerOf(sender: { readonly kind: 'agent' | 'human'; readonly id?: AgentId }): string {
  if (sender.kind !== 'agent' || sender.id === undefined) return HUMAN_WRITER;
  if (sender.id === HUMAN_WRITER) {
    throw invalid(`an agent may not use the reserved writer id ${HUMAN_WRITER}`);
  }
  return sender.id;
}

export function messageStore(
  ctx: StoreContext,
  resolveConversation: ConversationResolver,
): Pick<
  Store,
  | 'postMessage'
  | 'readStream'
  | 'readConversation'
  | 'readSpace'
  | 'searchMessages'
  | 'getAttachment'
  | 'renderAsOfRead'
  | 'readConversationAsOf'
> {
  const { db, st, now, nextSeq, toConversation, requireAgentRow, isCurrentMember } = ctx;
  const { newRenderCache, mentionName, toMessage, toEvent } = createRenderer(ctx);

  function tip(): number {
    return st.tip.get()?.next ?? 0;
  }

  /**
   * Current access, evaluated at read time. Everything an agent may not see
   * reports `not_found`, so error codes cannot map the fleet (ADR-0003).
   */
  function requireReadAccess(reader: Reader, space: SpaceId, what: string): void {
    if (reader.kind === 'human') return;
    if (!isCurrentMember(reader.id, space)) throw notFound(what);
  }

  /** Mentions resolved to references on the way in (ADR-0014). */
  function canonicalBody(space: SpaceId, body: string): string {
    return encodeMentions(body, (name) => {
      const row = st.resolveMentionName.get({ space, name });
      return row === undefined ? undefined : (row.id as AgentId);
    });
  }

  interface PostOutcome {
    readonly messageId: string;
  }

  function renderPost(messageId: string, created: boolean): PostMessageResult {
    const cache = newRenderCache();
    const row = st.messageById.get({ id: messageId });
    /* c8 ignore next */
    if (row === undefined) throw new Error(`message ${messageId} vanished`);
    const conversation = st.getConversation.get({ id: row.conversation_id });
    /* c8 ignore next */
    if (conversation === undefined) throw new Error('conversation vanished');
    return {
      message: toMessage(row, cache),
      conversation: toConversation(conversation),
      created,
    };
  }

  const postTx = db.transaction((input: PostMessageInput): PostMessageResult => {
    const { sender } = input;

    // Validate before anything else, including before the idempotency lookup:
    // a rejected write should be rejected identically whether or not its key
    // has been seen, and the reserved sequence must never reach a stored row
    // from input — the only one a row carries is the encoder's own mention
    // marker (text.ts), which is what makes that marker unforgeable.
    assertNoReservedSequence('body', input.body);
    if ('title' in input.target) assertNonEmpty('title', input.target.title);
    for (const attachment of input.attachments ?? []) {
      assertNoReservedSequence('filename', attachment.filename);
      assertNoReservedSequence('contentType', attachment.contentType);
    }
    if (input.body.trim().length === 0 && (input.attachments ?? []).length === 0) {
      throw invalid('body must not be empty unless the message carries an attachment');
    }

    const hash = requestHash({
      op: 'post',
      target:
        'conversation' in input.target
          ? { conversation: input.target.conversation }
          : { space: input.target.space, title: input.target.title },
      body: input.body,
      // Without `id`: attachment ids are minted per request, so a retry would
      // never hash the same. See `AttachmentInput.contentDigest`.
      attachments: (input.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        contentDigest: a.contentDigest ?? null,
      })),
    });

    if (input.idempotencyKey !== undefined) {
      const existing = st.getIdempotency.get({
        writer: writerOf(sender),
        key: input.idempotencyKey,
      });
      if (existing !== undefined) {
        // One namespace serves posts and escalations, and their outcomes
        // differ in shape. A key last used for the other operation is a
        // different request under the same key — the answer the hash check
        // below would give, reached before the outcome is trusted enough to
        // dereference.
        const outcome = JSON.parse(existing.outcome_json) as Partial<PostOutcome>;
        if (typeof outcome.messageId !== 'string') {
          throw invalid('idempotency key was already used for a different request');
        }
        const replayed = st.messageById.get({ id: outcome.messageId });
        /* c8 ignore next */
        if (replayed === undefined) throw new Error(`message ${outcome.messageId} vanished`);

        // A replay hands back a rendered message, so it is a read as well as a
        // write and follows current access like every other read. Otherwise an
        // agent removed from a space could recover its contents by replaying
        // keys it minted itself.
        //
        // Checked before the hash, so losing access looks the same whether the
        // replayed request matches or not — and the same as a space that never
        // existed (ADR-0003).
        if (sender.kind === 'agent' && !isCurrentMember(sender.id, replayed.space_id as SpaceId)) {
          throw notFound('conversation' in input.target ? 'conversation' : 'space');
        }

        // A different request under the same key is an error, not a silent
        // replay of the old answer.
        if (!constantTimeEquals(existing.request_hash, hash)) {
          throw invalid('idempotency key was already used for a different request');
        }
        return renderPost(outcome.messageId, false);
      }
    }

    // Resolve the target, then check access against the resolved space.
    let conversationRow: ConversationRow;
    if ('conversation' in input.target) {
      const found = st.getConversation.get({ id: input.target.conversation });
      if (found === undefined) throw notFound('conversation');
      if (sender.kind === 'agent' && !isCurrentMember(sender.id, found.space_id as SpaceId)) {
        throw notFound('conversation');
      }
      conversationRow = found;
    } else {
      const space = input.target.space;
      if (st.getSpace.get({ id: space }) === undefined) throw notFound('space');
      if (sender.kind === 'agent' && !isCurrentMember(sender.id, space)) throw notFound('space');
      conversationRow = resolveConversation(space, input.target.title, sender);
    }

    const space = conversationRow.space_id as SpaceId;
    const seq = nextSeq();
    const id = newId();
    const at = now();
    st.insertMessage.run({
      seq,
      id,
      conversation: conversationRow.id,
      space,
      senderKind: sender.kind,
      senderAgent: sender.kind === 'agent' ? sender.id : null,
      body: canonicalBody(space, input.body),
      at,
    });
    for (const attachment of input.attachments ?? []) {
      st.insertAttachment.run({
        id: attachment.id,
        message: id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.sizeBytes,
        at,
      });
    }

    // Same transaction as the write itself: a key never exists without its
    // outcome, nor an outcome without its key.
    if (input.idempotencyKey !== undefined) {
      const outcome: PostOutcome = { messageId: id };
      st.putIdempotency.run({
        writer: writerOf(sender),
        key: input.idempotencyKey,
        hash,
        outcome: JSON.stringify(outcome),
        at,
      });
    }

    return renderPost(id, true);
  });

  function anchorFor(from: ReadFrom | undefined, currentTip: number): number {
    if (from === undefined) return 0;
    if ('after' in from) return decodeCursor(from.after);
    if ('from' in from) return currentTip;
    // Anchored strictly before `since`, so an item at exactly that instant is
    // included: `since` is inclusive.
    const at = normalizeTimestamp('since', from.since);
    return st.streamAnchorBefore.get({ since: at })?.seq ?? 0;
  }

  const readStreamTx = db.transaction((agent: AgentId, args: ReadStreamArgs): StreamPage => {
    requireAgentRow(agent);
    const limit = clampLimit(args.limit);
    // Read the tip first and bound the query by it, so "everything up to here
    // was considered" is true of exactly the rows the query could have seen.
    const currentTip = tip();
    const after = anchorFor(args.from, currentTip);

    const rows = st.streamPage.all({ agent, after, tip: currentTip, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const cache = newRenderCache();
    const items: StreamItem[] = page.map((row) => {
      if (row.kind === 'message') {
        const message = st.messageBySeq.get({ seq: row.seq });
        /* c8 ignore next */
        if (message === undefined) throw new Error(`message at seq ${row.seq} vanished`);
        return toMessage(message, cache);
      }
      const event = st.eventBySeq.get({ seq: row.seq });
      /* c8 ignore next */
      if (event === undefined) throw new Error(`event at seq ${row.seq} vanished`);
      return toEvent(event);
    });

    // Items that failed the filter are skipped and the cursor advances past
    // them: never stall, never re-deliver later. When the page is not full,
    // everything up to the tip has been considered, so the cursor is the tip
    // rather than the last item's seq — which is what makes the stream
    // deliberately non-reproducible (ADR-0009).
    const lastSeq = page.at(-1)?.seq;
    const nextSeqValue = hasMore && lastSeq !== undefined ? lastSeq : Math.max(currentTip, after);
    const nextCursor = encodeCursor(nextSeqValue);

    recordRead(ctx, agent, 'stream', { from: args.from ?? null, limit }, nextCursor, items.length);
    return { items, nextCursor, hasMore };
  });

  interface QueryPlan {
    readonly order: 'oldest' | 'newest';
    /**
     * The exclusive bound in the direction of travel: a floor for `oldest`, a
     * ceiling for `newest`. One number either way, so a cursor stays one
     * opaque token and the direction stays a property of the request.
     */
    readonly after: number;
    readonly since: string | null;
    readonly until: string | null;
    readonly limit: number;
  }

  /**
   * `order` picks which end to start from and which way to walk; `since` and
   * `until` bound the same set either way. So the two orders return the same
   * messages, in opposite orders, from opposite ends.
   *
   * A cursor is a position, not a direction: handing an `oldest` cursor to a
   * `newest` read means "everything older than here", which is exactly what
   * turning around at a known point should mean.
   */
  function planQuery(range: Range | undefined, limit: number | undefined): QueryPlan {
    const order = range?.order ?? 'oldest';
    // The HTTP layer validates this against `Range`, but the store is also
    // called directly, and a typo would otherwise silently read backwards.
    if (order !== 'oldest' && order !== 'newest') {
      throw invalid("order must be 'oldest' or 'newest'");
    }
    return {
      order,
      after:
        range?.after !== undefined
          ? decodeQueryCursor(range.after)
          : // Nothing seen yet. Forwards that is the floor below every seq;
            // backwards it is a ceiling above every seq, taken once here so
            // that messages written mid-page cannot shift the window.
            order === 'oldest'
            ? 0
            : tip() + 1,
      since: range?.since === undefined ? null : normalizeTimestamp('since', range.since),
      until: range?.until === undefined ? null : normalizeTimestamp('until', range.until),
      limit: clampLimit(limit),
    };
  }

  /**
   * A query, not a stream position. Nothing is skipped, so the cursor is the
   * last row returned and an empty page leaves the position where it was —
   * unlike the stream, whose cursor jumps past what the access filter removed.
   *
   * `rows` already arrive in the requested order, so this is the same
   * arithmetic in both directions: the page is what fits, `hasMore` is the
   * row that did not, and the cursor is the last row handed over — the oldest
   * one when reading backwards, which is where the next page continues from.
   */
  function pageMessages(
    rows: readonly MessageRow[],
    plan: QueryPlan,
    cache: RenderCache = newRenderCache(),
  ): MessagePage {
    const hasMore = rows.length > plan.limit;
    const page = rows.slice(0, plan.limit);
    const lastSeq = page.at(-1)?.seq ?? plan.after;
    return {
      messages: page.map((row) => toMessage(row, cache)),
      nextCursor: encodeQueryCursor(lastSeq),
      hasMore,
    };
  }

  function conversationRows(conversation: ConversationId, plan: QueryPlan): MessageRow[] {
    const statement = plan.order === 'oldest' ? st.conversationPage : st.conversationPageBackwards;
    return statement.all({
      conversation,
      after: plan.after,
      since: plan.since,
      until: plan.until,
      limit: plan.limit + 1,
    });
  }

  const readAsOfTx = db.transaction(
    (
      read: string,
      conversation: ConversationId,
      range: Range | undefined,
      limit: number | undefined,
    ): MessagePage | undefined => {
      const position = st.readLabelSeq.get({ id: read });
      if (position === undefined || st.getConversation.get({ id: conversation }) === undefined) {
        return undefined;
      }
      // Nothing sent after the read: old labels on a message the agent could
      // not have seen would be a fiction. `until` is exclusive and the clock
      // is millisecond, so the ceiling is the millisecond after the read —
      // and the bound is that coarse: a row records when it read, not the
      // stream tip, so a message later in the same millisecond is included.
      const ceiling = new Date(Date.parse(position.read_at) + 1).toISOString() as Timestamp;
      const asked =
        range?.until === undefined ? undefined : normalizeTimestamp('until', range.until);
      const until = asked === undefined || asked > ceiling ? ceiling : asked;
      const plan = planQuery({ ...range, until }, limit);
      return pageMessages(
        conversationRows(conversation, plan),
        plan,
        newRenderCache(position.label_seq),
      );
    },
  );

  const readConversationTx = db.transaction(
    (
      reader: Reader,
      conversation: ConversationId,
      range: Range | undefined,
      limit: number | undefined,
    ): MessagePage => {
      const row = st.getConversation.get({ id: conversation });
      if (row === undefined) throw notFound('conversation');
      // Current access only. A space rejoined after a gap reads its whole
      // history here, including what the stream skipped.
      requireReadAccess(reader, row.space_id as SpaceId, 'conversation');

      const plan = planQuery(range, limit);
      const page = pageMessages(conversationRows(conversation, plan), plan);
      if (reader.kind === 'agent') {
        recordRead(
          ctx,
          reader.id,
          'conversation',
          { conversation, range: range ?? null, limit: plan.limit },
          page.nextCursor,
          page.messages.length,
        );
      }
      return page;
    },
  );

  const readSpaceTx = db.transaction(
    (
      reader: Reader,
      space: SpaceId,
      range: Range | undefined,
      limit: number | undefined,
    ): MessagePage => {
      if (st.getSpace.get({ id: space }) === undefined) throw notFound('space');
      requireReadAccess(reader, space, 'space');

      const plan = planQuery(range, limit);
      const statement = plan.order === 'oldest' ? st.spacePage : st.spacePageBackwards;
      const rows = statement.all({
        space,
        after: plan.after,
        since: plan.since,
        until: plan.until,
        limit: plan.limit + 1,
      });
      const page = pageMessages(rows, plan);
      if (reader.kind === 'agent') {
        recordRead(
          ctx,
          reader.id,
          'space',
          { space, range: range ?? null, limit: plan.limit },
          page.nextCursor,
          page.messages.length,
        );
      }
      return page;
    },
  );

  return {
    postMessage(input) {
      return postTx(input);
    },

    readStream(agent, args) {
      return readStreamTx(agent, args ?? {});
    },

    readConversation(reader, conversation, range, limit) {
      return readConversationTx(reader, conversation, range, limit);
    },

    readSpace(reader, space, range, limit) {
      return readSpaceTx(reader, space, range, limit);
    },

    searchMessages(query, opts) {
      // The human's search (architecture: the admin API). Mentions are
      // reference tokens in the indexed text, so searching for an agent means
      // searching for its id — and a rename touches no index.
      assertNoReservedSequence('query', query);
      const cache = newRenderCache();
      const limit = clampLimit(opts?.limit);
      const order = opts?.order ?? 'relevance';
      if (order !== 'relevance' && order !== 'newest') {
        throw invalid("order must be 'relevance' or 'newest'");
      }
      const after = opts?.after === undefined ? undefined : decodeSearchCursor(opts.after);
      if (after !== undefined && after.order !== order) {
        throw invalid(`the cursor is from a ${after.order}-ordered search; ask for that order`);
      }
      const bounds: SearchBounds = {
        query,
        space: opts?.space ?? null,
        afterSeq: after?.seq ?? null,
        afterRank: after?.order === 'relevance' ? after.rank : 0,
        limit: limit + 1,
      };
      let rows;
      try {
        rows = (order === 'relevance' ? st.searchByRank : st.searchNewest).all(bounds);
      } catch (error) {
        // FTS5 parses the query itself and rejects bad syntax as a plain
        // SQLITE_ERROR — a typo surfacing as an internal fault. The query is
        // reported back unchanged and never rewritten into one that parses: a
        // search that quietly means something else is worse than one that says
        // it cannot be read.
        if (error instanceof Database.SqliteError && error.code === 'SQLITE_ERROR') {
          throw invalid(`search query is not valid FTS5 syntax: ${error.message}`);
        }
        throw error;
      }
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        hits: page.map((row) => ({
          message: toMessage(row, cache),
          // A snippet is a fragment of the stored body, so it is rendered like
          // the body: references become names, and the marker never leaves.
          snippet: renderSnippet(
            row.snippet,
            (agent) => mentionName(cache, row.space_id, agent),
            SNIPPET_OPEN,
            SNIPPET_CLOSE,
          ),
        })),
        nextCursor:
          last === undefined
            ? (opts?.after ?? null)
            : encodeSearchCursor(
                order === 'relevance'
                  ? { order, seq: last.seq, rank: last.rank }
                  : { order, seq: last.seq },
              ),
        hasMore,
      };
    },

    getAttachment(attachment) {
      const row = st.getAttachment.get({ id: attachment });
      if (row === undefined) return undefined;
      return {
        id: row.id as AttachmentId,
        filename: row.filename,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        message: row.message_id as MessageId,
        space: row.space_id as SpaceId,
      };
    },

    renderAsOfRead(message, read) {
      const row = st.messageById.get({ id: message });
      const position = st.readLabelSeq.get({ id: read });
      if (row === undefined || position === undefined) return undefined;
      return toMessage(row, newRenderCache(position.label_seq));
    },

    readConversationAsOf(read, conversation, range, limit) {
      return readAsOfTx(read, conversation, range, limit);
    },
  };
}
