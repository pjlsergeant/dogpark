/** The read log: recording reads, and the forensic view over them (ADR-0005). */
import type { AgentId, Cursor, Timestamp } from '../types.js';
import type { StoreContext } from './context.js';
import { decodeReadLogCursor, encodeReadLogCursor } from './cursors.js';
import { invalid } from './errors.js';
import { newId } from './ids.js';
import { clampLimit } from './limits.js';
import type { CollapseResume, CollapseSeed, ReadKind, ReadLogEntry, Store } from './records.js';
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

/**
 * How many candidates one call holds and considers. The sweep is unbounded in
 * what it has to walk — an instance upgraded after months of idle long-polling
 * has one candidate per poll — so it is bounded in what it holds: memory, the
 * length of any single transaction, and the time the event loop is held, are
 * constant in the size of the log. Large enough that an ordinary hourly sweep
 * is one call.
 */
const COLLAPSE_BATCH = 5000;

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

  interface BatchResult {
    readonly collapsed: number;
    readonly removed: number;
    /** Rows the batch fetched; fewer than the limit means the walk is done. */
    readonly fetched: number;
    /** Where the next batch picks the walk up. */
    readonly resume: CollapseResume;
  }

  /** An agent's chain so far: its rows, and whether its head is already counted. */
  interface OpenChain {
    readonly rows: EmptyStreamReadRow[];
    readonly counted: boolean;
  }

  /**
   * One batch of candidates, and the chains they extend. Candidates arrive in
   * the order they were written, every agent interleaved, so each agent's open
   * chain is tracked separately. A chain is compacted into its last row — a
   * real read, keeping its own id, cursor and parameters — and the rest of the
   * run is deleted, both in this transaction: a half-collapsed run would
   * double-count the reads it stands for.
   *
   * The resume state carries each agent's surviving row out of this batch and
   * into the next, so a run split by a batch boundary is compacted twice, the
   * second time with the first half's survivor as an ordinary candidate. That
   * is the same property that makes repeated sweeps converge on one row per
   * idle stretch: without the seed the survivors could not be rejoined at all,
   * since collapsing a run discards the row whose cursor the next one resumed
   * from. Compacting a run twice is not counting it twice: the seed remembers
   * that its run has been counted, so `collapsed` is the number of logical runs
   * whatever the batch size.
   */
  const collapseBatchTx = db.transaction(
    (olderThan: string, from: CollapseResume, limit: number): BatchResult => {
      let collapsed = 0;
      let removed = 0;
      const chains = new Map<string, OpenChain>();
      for (const [agent, seed] of from.seeds) {
        chains.set(agent, { rows: [seed.row], counted: seed.counted });
      }

      /** Compacts a chain, and reports the row that survived it. */
      function flush(chain: OpenChain): CollapseSeed {
        const first = chain.rows[0];
        const last = chain.rows.at(-1);
        /* c8 ignore next */
        if (first === undefined || last === undefined) throw new Error('an empty chain');
        if (chain.rows.length === 1) return { row: last, counted: chain.counted };
        const count = chain.rows.reduce((total, row) => total + row.collapsed_count, 0);
        const firstReadAt = first.first_read_at ?? first.read_at;
        st.collapseRead.run({ row: last.row_id, count, first: firstReadAt });
        for (const row of chain.rows.slice(0, -1)) {
          st.deleteReadRow.run({ row: row.row_id });
          removed += 1;
        }
        // A run the previous batch already compacted is the same run, not a
        // second one: only its first compaction counts.
        if (!chain.counted) collapsed += 1;
        // What the row now says, so that seeding the next batch with it sums
        // the run once rather than once per batch.
        return {
          row: { ...last, collapsed_count: count, first_read_at: firstReadAt },
          counted: true,
        };
      }

      const rows = st.emptyStreamReads.all({
        before: olderThan,
        afterRow: from.afterRow,
        limit,
      });
      for (const row of rows) {
        const chain = chains.get(row.agent_id);
        const previous = chain?.rows.at(-1);
        if (chain !== undefined && previous !== undefined && resumes(previous, row)) {
          chain.rows.push(row);
        } else {
          if (chain !== undefined) flush(chain);
          chains.set(row.agent_id, { rows: [row], counted: false });
        }
      }
      const seeds = new Map<string, CollapseSeed>();
      for (const [agent, chain] of chains) seeds.set(agent, flush(chain));

      return {
        collapsed,
        removed,
        fetched: rows.length,
        resume: { afterRow: rows.at(-1)?.row_id ?? from.afterRow, seeds },
      };
    },
  );

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

    collapseEmptyStreamReads(olderThan, options) {
      const batchSize = options?.batchSize ?? COLLAPSE_BATCH;
      if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw invalid('batchSize must be a positive integer');
      }
      const before = normalizeTimestamp('olderThan', olderThan);
      // Deletions only ever remove rows at or behind `afterRow`, so the keyset
      // walk is not disturbed by the sweep's own writes.
      const from = options?.resume ?? { afterRow: 0, seeds: new Map<string, CollapseSeed>() };
      const batch = collapseBatchTx(before, from, batchSize);
      return {
        collapsed: batch.collapsed,
        removed: batch.removed,
        // A short batch is the end of the walk: there was nothing left to fill it.
        done: batch.fetched < batchSize,
        resume: batch.resume,
      };
    },
  };
}
