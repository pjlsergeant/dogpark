import type { AgentId, ConversationId, Sender, SpaceId, Timestamp } from '../types.js';
import { decodeQueryCursor, encodeQueryCursor } from './cursors.js';
import type { StoreContext } from './context.js';
import { notFound } from './errors.js';
import type { Store } from './records.js';
import type { HumanCatchUpRow } from './statements.js';

export function humanReadMarkStore(
  ctx: StoreContext,
): Pick<Store, 'advanceHumanReadMark' | 'listHumanCatchUp'> {
  const { st, now, humanDisplayName } = ctx;

  const sender = (row: HumanCatchUpRow): Sender =>
    row.last_sender_agent_id === null
      ? { kind: 'human', displayName: humanDisplayName }
      : {
          kind: 'agent',
          id: row.last_sender_agent_id as AgentId,
          displayName: row.last_sender_name ?? row.last_sender_agent_id,
        };

  return {
    advanceHumanReadMark(conversation, message) {
      if (st.getConversation.get({ id: conversation }) === undefined)
        throw notFound('conversation');
      const row = st.messageById.get({ id: message });
      if (row === undefined || row.conversation_id !== conversation) throw notFound('message');
      return st.advanceHumanReadMark.run({ conversation, seq: row.seq, at: now() }).changes > 0;
    },

    listHumanCatchUp(options = {}) {
      const limit = options.limit ?? 50;
      const after = options.after === undefined ? null : decodeQueryCursor(options.after);
      const rows = st.humanCatchUp.all({ after, limit: limit + 1 });
      const page = rows.slice(0, limit);
      return {
        conversations: page.map((row) => ({
          id: row.id as ConversationId,
          space: { id: row.space_id as SpaceId, name: row.space_name },
          title: row.title,
          unreadCount: row.unread_count,
          latestActivitySeq: row.latest_seq,
          latestActivityAt: row.latest_at as Timestamp,
          lastSender: sender(row),
          status: row.status === 'complete' ? 'complete' : 'open',
          hasPins: row.has_pins !== 0,
        })),
        nextCursor:
          page.length === 0 ? (options.after ?? null) : encodeQueryCursor(page.at(-1)!.latest_seq),
        hasMore: rows.length > limit,
      };
    },
  };
}
