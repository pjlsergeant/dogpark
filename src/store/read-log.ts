/** The read log: recording reads, and the forensic view over them (ADR-0005). */
import type { AgentId, Cursor, Timestamp } from '../types.js';
import type { StoreContext } from './context.js';
import { decodeReadLogCursor, encodeReadLogCursor } from './cursors.js';
import { newId } from './ids.js';
import { clampLimit } from './limits.js';
import type { ReadKind, ReadLogEntry, Store } from './records.js';
import type { EmptyStreamReadRow, ReadLogBounds, ReadLogRow } from './statements.js';
import { normalizeTimestamp } from './text.js';

/**
 * Where a stream read started and how much it asked for, as its row recorded
 * them (`{ from, limit }`). Undefined for anything else — including
 * params_json that will not parse, or a shape no stream read writes: a row
 * that cannot be read is a chain breaker rather than a fault.
 */
interface StreamReadParams {
  /** The cursor it resumed from, if it resumed from one at all. */
  readonly after: string | undefined;
  readonly limit: number;
}

function streamParams(json: string): StreamReadParams | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { from, limit } = parsed as { from?: unknown; limit?: unknown };
  if (typeof limit !== 'number') return undefined;
  const after =
    typeof from === 'object' && from !== null ? (from as { after?: unknown }).after : undefined;
  return { after: typeof after === 'string' ? after : undefined, limit };
}

/**
 * Whether `next` is the same poll repeated: it resumed from exactly where
 * `previous` left off, asking for the same page size. That covers the idle
 * agent whose cursor never moves and the agent whose cursor advances past
 * traffic it cannot see — both are a run of polls that returned nothing.
 *
 * A read that returned something is not a candidate at all, and it breaks any
 * chain across it for free: the next poll resumes from *its* cursor, which is
 * not the previous empty read's.
 */
function resumes(previous: EmptyStreamReadRow, next: EmptyStreamReadRow): boolean {
  const before = streamParams(previous.params_json);
  const after = streamParams(next.params_json);
  if (before === undefined || after === undefined) return false;
  return after.after === previous.cursor && after.limit === before.limit;
}

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
): Pick<
  Store,
  'readReadLog' | 'getRead' | 'lastReadCursor' | 'recordAttachmentRead' | 'collapseEmptyStreamReads'
> {
  const { db, st, requireAgentRow } = ctx;

  function toReadLogEntry(row: ReadLogRow): ReadLogEntry {
    return {
      id: row.id,
      agent: row.agent_id as AgentId,
      readAt: row.read_at as Timestamp,
      kind: row.kind as ReadKind,
      params: JSON.parse(row.params_json) as unknown,
      cursor: row.cursor,
      itemCount: row.item_count,
      collapsedCount: row.collapsed_count,
      ...(row.first_read_at === null ? {} : { firstReadAt: row.first_read_at as Timestamp }),
    };
  }

  /**
   * One pass over the candidates, which arrive grouped by agent and in the
   * order they were written. A chain is compacted into its last row — a real
   * read, keeping its own id, cursor and parameters — and the rest of the run
   * is deleted. One transaction: a half-collapsed run would double-count the
   * reads it stands for.
   */
  const collapseTx = db.transaction((olderThan: string): { collapsed: number; removed: number } => {
    let collapsed = 0;
    let removed = 0;
    let chain: EmptyStreamReadRow[] = [];

    function flush(): void {
      const first = chain[0];
      const last = chain.at(-1);
      if (chain.length > 1 && first !== undefined && last !== undefined) {
        st.collapseRead.run({
          row: last.row_id,
          count: chain.reduce((total, row) => total + row.collapsed_count, 0),
          first: first.first_read_at ?? first.read_at,
        });
        for (const row of chain.slice(0, -1)) {
          st.deleteReadRow.run({ row: row.row_id });
          removed += 1;
        }
        collapsed += 1;
      }
      chain = [];
    }

    for (const row of st.emptyStreamReads.all({ before: olderThan })) {
      const previous = chain.at(-1);
      if (
        previous !== undefined &&
        !(previous.agent_id === row.agent_id && resumes(previous, row))
      ) {
        flush();
      }
      chain.push(row);
    }
    flush();
    return { collapsed, removed };
  });

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

    getRead(read) {
      const row = st.readLogById.get({ id: read });
      return row === undefined ? undefined : toReadLogEntry(row);
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

    collapseEmptyStreamReads(olderThan) {
      return collapseTx(normalizeTimestamp('olderThan', olderThan));
    },
  };
}
