import type {
  AgentId,
  ConversationAnnotations,
  ConversationId,
  IdempotencyKey,
  MessageId,
  Sender,
  SpaceId,
} from '../types.js';
import type { StoreContext } from './context.js';
import { invalid, notFound } from './errors.js';
import { constantTimeEquals, requestHash } from './hash.js';
import type { Reader, Store } from './records.js';
import { assertNoReservedSequence } from './text.js';

type AnnotationKind = 'completed' | 'reopened' | 'pinned' | 'unpinned';
interface AnnotationRow {
  seq: number;
  kind: AnnotationKind;
  actor_kind: 'agent' | 'human';
  actor_agent_id: string | null;
  message_id: string | null;
}

const HUMAN_WRITER = ':human';
const writerOf = (actor: Reader): string => (actor.kind === 'agent' ? actor.id : HUMAN_WRITER);

export function annotationStore(
  ctx: StoreContext,
): Pick<
  Store,
  | 'getConversationAnnotations'
  | 'getConversationAnnotationsAsOf'
  | 'completeConversation'
  | 'reopenConversation'
  | 'pinMessage'
  | 'unpinConversation'
> {
  const { db, st, now, nextSeq, humanDisplayName, isCurrentMember } = ctx;
  // Two cutoffs, never both: a tip seq for a read that recorded one, or the
  // clock for a legacy row (`before` is the exclusive millisecond ceiling the
  // message reconstruction uses, so the two views agree on the same instant).
  const rows = db.prepare<
    { conversation: string; tip: number | null; before: string | null },
    AnnotationRow
  >(
    'SELECT seq, kind, actor_kind, actor_agent_id, message_id ' +
      'FROM conversation_annotation WHERE conversation_id = @conversation ' +
      'AND (@tip IS NULL OR seq <= @tip) AND (@before IS NULL OR created_at < @before) ' +
      'ORDER BY seq',
  );
  const insert = db.prepare(
    'INSERT INTO conversation_annotation ' +
      '(seq, conversation_id, kind, actor_kind, actor_agent_id, message_id, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  function state(
    conversation: ConversationId,
    cutoff: { tip: number | null; before: string | null },
    labelSeq?: number,
  ): ConversationAnnotations {
    if (st.getConversation.get({ id: conversation }) === undefined) throw notFound('conversation');
    let status: 'open' | 'complete' = 'open';
    const pins = new Map<string, AnnotationRow>();
    for (const row of rows.all({ conversation, ...cutoff })) {
      if (row.kind === 'completed') status = 'complete';
      else if (row.kind === 'reopened') status = 'open';
      else {
        const key = row.actor_kind === 'human' ? 'human' : `agent:${row.actor_agent_id}`;
        if (row.kind === 'pinned') pins.set(key, row);
        else pins.delete(key);
      }
    }
    return {
      status,
      pins: [...pins.values()].map((row) => {
        let actor: Sender;
        if (row.actor_kind === 'human') actor = { kind: 'human', displayName: humanDisplayName };
        else {
          const agent = st.getAgent.get({ id: row.actor_agent_id as string });
          /* c8 ignore next */
          if (agent === undefined) throw new Error('annotation references a missing agent');
          const displayName =
            labelSeq === undefined
              ? agent.display_name
              : (st.labelAsOf.get({
                  kind: 'agent',
                  subject: row.actor_agent_id as string,
                  labelSeq,
                })?.label ?? agent.display_name);
          actor = {
            kind: 'agent',
            id: row.actor_agent_id as AgentId,
            displayName,
          };
        }
        return { message: row.message_id as MessageId, actor };
      }),
    };
  }

  function requireAccess(actor: Reader, conversation: ConversationId) {
    const found = st.getConversation.get({ id: conversation });
    if (found === undefined) throw notFound('conversation');
    if (actor.kind === 'agent' && !isCurrentMember(actor.id, found.space_id as SpaceId)) {
      throw notFound('conversation');
    }
    return found;
  }

  const actionTx = db.transaction(
    (
      actor: Reader,
      conversation: ConversationId,
      kind: AnnotationKind,
      message: MessageId | undefined,
      idempotencyKey: IdempotencyKey | undefined,
    ): boolean => {
      requireAccess(actor, conversation);
      if (idempotencyKey !== undefined) assertNoReservedSequence('idempotencyKey', idempotencyKey);
      const hash = requestHash({ op: kind, conversation, message: message ?? null });
      if (idempotencyKey !== undefined) {
        const existing = st.getIdempotency.get({ writer: writerOf(actor), key: idempotencyKey });
        if (existing !== undefined) {
          if (!constantTimeEquals(existing.request_hash, hash)) {
            throw invalid('idempotency key was already used for a different request');
          }
          const outcome = JSON.parse(existing.outcome_json) as { annotationChanged?: unknown };
          if (typeof outcome.annotationChanged !== 'boolean') {
            throw invalid('idempotency key was already used for a different request');
          }
          // A replay applies nothing and reports nothing changed; the caller
          // then reads the current state, which is the honest answer even when
          // someone has moved it since (documented in http-api.md).
          return false;
        }
      }

      const before = state(conversation, { tip: null, before: null });
      const ownPin = before.pins.find((pin) =>
        actor.kind === 'human'
          ? pin.actor.kind === 'human'
          : pin.actor.kind === 'agent' && pin.actor.id === actor.id,
      );
      let changed = true;
      if (kind === 'completed' && before.status === 'complete') changed = false;
      if (kind === 'reopened' && before.status === 'open') changed = false;
      if (kind === 'unpinned' && ownPin === undefined) changed = false;
      if (kind === 'pinned') {
        const target = message === undefined ? undefined : st.messageById.get({ id: message });
        if (target === undefined || target.conversation_id !== conversation)
          throw notFound('message');
        if (ownPin?.message === message) changed = false;
      }
      const at = now();
      if (changed) {
        insert.run(
          nextSeq(),
          conversation,
          kind,
          actor.kind,
          actor.kind === 'agent' ? actor.id : null,
          kind === 'pinned' ? message : null,
          at,
        );
      }
      if (idempotencyKey !== undefined) {
        st.putIdempotency.run({
          writer: writerOf(actor),
          key: idempotencyKey,
          hash,
          outcome: JSON.stringify({ annotationChanged: changed }),
          at,
        });
      }
      return changed;
    },
  );

  return {
    getConversationAnnotations(conversation) {
      return state(conversation, { tip: null, before: null });
    },
    getConversationAnnotationsAsOf(conversation, cutoff, labelSeq) {
      return state(
        conversation,
        'tip' in cutoff ? { tip: cutoff.tip, before: null } : { tip: null, before: cutoff.before },
        labelSeq,
      );
    },
    completeConversation(actor, conversation, key) {
      return actionTx(actor, conversation, 'completed', undefined, key);
    },
    reopenConversation(actor, conversation, key) {
      return actionTx(actor, conversation, 'reopened', undefined, key);
    },
    pinMessage(actor, conversation, message, key) {
      return actionTx(actor, conversation, 'pinned', message, key);
    },
    unpinConversation(actor, conversation, key) {
      return actionTx(actor, conversation, 'unpinned', undefined, key);
    },
  };
}
