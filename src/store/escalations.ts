/** Escalations, carrying their own notification retry state. */
import type { AgentId, ConversationId, SpaceId, Timestamp } from '../types.js';
import type { StoreContext } from './context.js';
import { invalid, notFound } from './errors.js';
import { decodeEscalationCursor, encodeEscalationCursor } from './cursors.js';
import { constantTimeEquals, requestHash } from './hash.js';
import { newId } from './ids.js';
import { clampLimit } from './limits.js';
import type {
  EscalationOutcome,
  EscalationRecord,
  NotificationState,
  RecordEscalationInput,
  Store,
} from './records.js';
import type { EscalationBounds, EscalationRow } from './statements.js';
import { assertNonEmpty, normalizeTimestamp } from './text.js';

export function escalationStore(
  ctx: StoreContext,
): Pick<
  Store,
  | 'recordEscalation'
  | 'listEscalations'
  | 'countUndeliveredEscalations'
  | 'markEscalationNotification'
> {
  const { db, st, now, isCurrentMember } = ctx;

  function toEscalation(row: EscalationRow): EscalationRecord {
    return {
      id: row.id,
      agent: row.agent_id as AgentId,
      conversation: row.conversation_id as ConversationId,
      reason: row.reason,
      createdAt: row.created_at as Timestamp,
      notificationState: row.notification_state as NotificationState,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at as Timestamp | null,
      nextAttemptAt: row.next_attempt_at as Timestamp | null,
      lastError: row.last_error,
    };
  }

  interface EscalationOutcomeRecord {
    readonly escalationId: string;
  }

  const escalateTx = db.transaction((input: RecordEscalationInput): EscalationOutcome => {
    assertNonEmpty('reason', input.reason);

    const hash = requestHash({
      op: 'escalate',
      conversation: input.conversation,
      reason: input.reason,
    });

    const existing = st.getIdempotency.get({ writer: input.agent, key: input.idempotencyKey });
    if (existing !== undefined) {
      // As in `postMessage`: a key last used for a post is a different request.
      const outcome = JSON.parse(existing.outcome_json) as Partial<EscalationOutcomeRecord>;
      if (typeof outcome.escalationId !== 'string') {
        throw invalid('idempotency key was already used for a different request');
      }
      const row = st.getEscalation.get({ id: outcome.escalationId });
      /* c8 ignore next */
      if (row === undefined) throw new Error('escalation vanished');
      // Same rule as a replayed post: a replay is a read, and reads follow
      // current access. Less to leak here — the reason is the agent's own
      // words — but confirming an escalation about a space it can no longer
      // see is still an answer it is not entitled to.
      const raisedIn = st.getConversation.get({ id: row.conversation_id });
      /* c8 ignore next */
      if (raisedIn === undefined) throw new Error('escalation references a missing conversation');
      if (!isCurrentMember(input.agent, raisedIn.space_id as SpaceId))
        throw notFound('conversation');
      if (!constantTimeEquals(existing.request_hash, hash)) {
        throw invalid('idempotency key was already used for a different request');
      }
      return { escalation: toEscalation(row), created: false };
    }

    const conversation = st.getConversation.get({ id: input.conversation });
    if (conversation === undefined) throw notFound('conversation');
    if (!isCurrentMember(input.agent, conversation.space_id as SpaceId)) {
      throw notFound('conversation');
    }

    const id = newId();
    const at = now();
    st.insertEscalation.run({
      id,
      agent: input.agent,
      conversation: input.conversation,
      reason: input.reason,
      at,
    });
    const outcome: EscalationOutcomeRecord = { escalationId: id };
    st.putIdempotency.run({
      writer: input.agent,
      key: input.idempotencyKey,
      hash,
      outcome: JSON.stringify(outcome),
      at,
    });
    const row = st.getEscalation.get({ id });
    /* c8 ignore next */
    if (row === undefined) throw new Error('escalation vanished');
    return { escalation: toEscalation(row), created: true };
  });

  return {
    recordEscalation(input) {
      return escalateTx(input);
    },

    listEscalations(filter) {
      const limit = clampLimit(filter?.limit);
      const order = filter?.order ?? 'oldest';
      if (order !== 'oldest' && order !== 'newest') {
        throw invalid("order must be 'oldest' or 'newest'");
      }
      const after = filter?.after === undefined ? undefined : decodeEscalationCursor(filter.after);
      if (after !== undefined && after.order !== order) {
        throw invalid(`the cursor is from a ${after.order}-first listing; ask for that order`);
      }
      const bounds: EscalationBounds = {
        state: filter?.state ?? null,
        dueAt: filter?.dueAt === undefined ? null : normalizeTimestamp('dueAt', filter.dueAt),
        afterAt: after?.createdAt ?? null,
        afterId: after?.id ?? '',
        // One more than asked for, so `hasMore` is observed and not guessed.
        limit: limit + 1,
      };
      const statement = order === 'oldest' ? st.escalationsOldest : st.escalationsNewest;
      const rows = statement.all(bounds);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        escalations: page.map(toEscalation),
        nextCursor:
          last === undefined
            ? (filter?.after ?? null)
            : encodeEscalationCursor({ order, createdAt: last.created_at, id: last.id }),
        hasMore,
      };
    },

    countUndeliveredEscalations() {
      return st.countUndelivered.get()?.n ?? 0;
    },

    markEscalationNotification(escalation, state, opts) {
      if (st.getEscalation.get({ id: escalation }) === undefined) throw notFound('escalation');
      st.markEscalation.run({
        id: escalation,
        state,
        at: now(),
        error: opts?.error ?? null,
        next: opts?.nextAttemptAt ?? null,
      });
      const row = st.getEscalation.get({ id: escalation });
      /* c8 ignore next */
      if (row === undefined) throw new Error('escalation vanished');
      return toEscalation(row);
    },
  };
}
