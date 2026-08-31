/** Conversations: one thread inside a space, addressed by title as well as id (ADR-0012). */
import type { Transaction } from 'better-sqlite3';
import type {
  AgentId,
  Conversation,
  ConversationId,
  Sender,
  SpaceId,
  Timestamp,
} from '../types.js';
import type { StoreContext } from './context.js';
import { notFound, uniqueOr } from './errors.js';
import { newId } from './ids.js';
import type { Reader, Store } from './records.js';
import type { ConversationRow, ConversationSummaryRow } from './statements.js';
import { assertNonEmpty } from './text.js';

export type ConversationResolver = Transaction<
  (space: SpaceId, title: string, createdBy: Reader | undefined) => ConversationRow
>;

/**
 * Resolve-or-create in one statement pair inside one transaction, so two
 * writers racing on the same subject line cannot open two threads
 * (ADR-0012). Built once by `openStore` and shared with `postMessage`, which
 * is how threads are opened in production.
 */
export function conversationResolver(ctx: StoreContext): ConversationResolver {
  const { db, st, now } = ctx;
  return db.transaction(
    (space: SpaceId, title: string, createdBy: Reader | undefined): ConversationRow => {
      st.insertConversation.run({
        id: newId(),
        space,
        title,
        at: now(),
        by: createdBy !== undefined && createdBy.kind === 'agent' ? createdBy.id : null,
      });
      const row = st.conversationByTitle.get({ space, title });
      /* c8 ignore next */
      if (row === undefined) throw new Error('conversation vanished after insert');
      return row;
    },
  );
}

export function conversationStore(
  ctx: StoreContext,
  resolveConversation: ConversationResolver,
  getAnnotations: Store['getConversationAnnotations'],
): Pick<
  Store,
  | 'resolveOrCreateConversation'
  | 'getConversation'
  | 'renameConversation'
  | 'listConversationSummaries'
> {
  const { db, st, now, humanDisplayName, toConversation, requireSpaceRow } = ctx;

  function toOpener(row: ConversationSummaryRow): Sender {
    if (row.opened_by_agent_id === null) return { kind: 'human', displayName: humanDisplayName };
    /* c8 ignore next */
    if (row.opener_name === null) throw new Error('conversation references a missing agent');
    return { kind: 'agent', id: row.opened_by_agent_id as AgentId, displayName: row.opener_name };
  }

  /** The sender of a conversation's last message, or null if it has none. */
  function toLastSender(row: ConversationSummaryRow): Sender | null {
    if (row.last_sender_kind === null) return null;
    if (row.last_sender_agent_id === null) {
      // No user record: the human's name is configuration, like everywhere.
      return { kind: 'human', displayName: humanDisplayName };
    }
    /* c8 ignore next */
    if (row.last_sender_name === null) throw new Error('message references a missing agent');
    return {
      kind: 'agent',
      id: row.last_sender_agent_id as AgentId,
      displayName: row.last_sender_name,
    };
  }

  const renameConversationTx = db.transaction(
    (conversation: ConversationId, title: string): Conversation => {
      const before = st.getConversation.get({ id: conversation });
      if (before === undefined) throw notFound('conversation');
      if (before.title !== title) {
        try {
          st.renameConversation.run({ id: conversation, title });
        } catch (error) {
          throw uniqueOr(error, 'a conversation with that title already exists in this space');
        }
        st.insertLabelHistory.run({
          kind: 'conversation',
          subject: conversation,
          label: before.title,
          until: now(),
        });
      }
      const renamed = st.getConversation.get({ id: conversation });
      /* c8 ignore next */
      if (renamed === undefined) throw new Error('conversation vanished');
      return toConversation(renamed);
    },
  );

  return {
    resolveOrCreateConversation(space, title, createdBy) {
      requireSpaceRow(space);
      assertNonEmpty('title', title);
      return toConversation(resolveConversation(space, title, createdBy));
    },

    getConversation(conversation) {
      const row = st.getConversation.get({ id: conversation });
      return row === undefined ? undefined : toConversation(row);
    },

    renameConversation(conversation, title) {
      assertNonEmpty('title', title);
      return renameConversationTx(conversation, title);
    },

    listConversationSummaries(space) {
      requireSpaceRow(space);
      return st.conversationSummaries.all({ space }).map((row) => ({
        ...toConversation(row),
        openedBy: toOpener(row),
        messageCount: row.message_count,
        lastActivityAt: row.last_sent_at as Timestamp | null,
        lastSender: toLastSender(row),
        annotations: getAnnotations(row.id as ConversationId),
      }));
    },
  };
}
