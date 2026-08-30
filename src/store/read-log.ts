/** The read log: recording reads, and the forensic view over them (ADR-0005). */
import type { AgentId, Cursor, Timestamp } from '../types.js';
import type { StoreContext } from './context.js';
import { decodeReadLogCursor, encodeReadLogCursor } from './cursors.js';
import { newId } from './ids.js';
import { clampLimit } from './limits.js';
import type { ReadKind, ReadLogEntry, Store } from './records.js';
import type { ReadLogBounds, ReadLogRow } from './statements.js';
import { normalizeTimestamp } from './text.js';

export function recordRead(
  ctx: StoreContext,
  agent: AgentId,
  kind: ReadKind,
  params: unknown,
  cursor: string,
  itemCount: number,
): void {
  ctx.st.insertRead.run({
    id: newId(),
    agent,
    at: ctx.now(),
    kind,
    params: JSON.stringify(params ?? null),
    cursor,
    count: itemCount,
  });
}

export function readLogStore(
  ctx: StoreContext,
): Pick<Store, 'readReadLog' | 'lastReadCursor' | 'recordAttachmentRead'> {
  const { st, requireAgentRow } = ctx;

  function toReadLogEntry(row: ReadLogRow): ReadLogEntry {
    return {
      id: row.id,
      agent: row.agent_id as AgentId,
      readAt: row.read_at as Timestamp,
      kind: row.kind as ReadKind,
      params: JSON.parse(row.params_json) as unknown,
      cursor: row.cursor,
      itemCount: row.item_count,
    };
  }

  return {
    readReadLog(filter) {
      const limit = clampLimit(filter?.limit);
      const after = filter?.after === undefined ? undefined : decodeReadLogCursor(filter.after);
      const bounds: ReadLogBounds = {
        since: filter?.since === undefined ? null : normalizeTimestamp('since', filter.since),
        until: filter?.until === undefined ? null : normalizeTimestamp('until', filter.until),
        afterAt: after?.readAt ?? null,
        afterRow: after?.rowId ?? 0,
        // One more than asked for, so `hasMore` is observed and not guessed.
        limit: limit + 1,
      };
      const rows =
        filter?.agent === undefined
          ? st.listReads.all(bounds)
          : st.listReadsForAgent.all({ ...bounds, agent: filter.agent });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map(toReadLogEntry),
        // Like the message queries and unlike the stream: nothing is skipped,
        // so an empty page leaves the position exactly where it was.
        nextCursor:
          last === undefined
            ? (filter?.after ?? null)
            : encodeReadLogCursor({ readAt: last.read_at, rowId: last.row_id }),
        hasMore,
      };
    },

    lastReadCursor(agent) {
      const row = st.lastStreamRead.get({ agent });
      return row === undefined ? undefined : (row.cursor as Cursor);
    },

    recordAttachmentRead(agent, attachment, message) {
      requireAgentRow(agent);
      // No position comes back from a file, so the cursor is empty rather
      // than invented; the parameters say which file, and whose message.
      recordRead(ctx, agent, 'attachment', { attachment, message }, '', 1);
    },
  };
}
