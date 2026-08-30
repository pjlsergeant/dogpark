/**
 * The read log: one row per read call, with the parameters it read with.
 *
 * The question this screen answers is "had this agent seen the instruction
 * when it acted?". Recording the parameters is what makes that answerable: a
 * cursor at the head means the agent is *here*, not that it was handed
 * everything behind here, so a seek has to be visibly a seek (ADR-0005).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentId, ReadLogEntry } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { href, navigate } from '../app/router.js';
import { Empty, Failure, Loading } from '../components/bits.js';
import { ReadLogRows } from './ReadLogRows.js';

export function ReadLogScreen({ agent }: { agent?: AgentId | undefined }): ReactNode {
  const api = useApi();
  const agents = useAsync(() => api.listAgents(), [api]);
  const reads = useAsync(
    () => api.listReads(agent === undefined ? undefined : { agent }),
    [api, agent],
  );

  // Pages after the first accumulate here; the filter change that refetches
  // the first page clears them.
  const [tail, setTail] = useState<{
    readonly items: readonly ReadLogEntry[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  /**
   * Bumped whenever the first page is replaced — a filter change or a Refresh.
   * A page that was already out when that happened belongs to a log this
   * screen is no longer showing, so it discards itself instead of appending
   * one agent's rows beneath another's.
   */
  const generation = useRef(0);

  /** Forget the tail; the first page it hung off is being replaced. */
  const reset = useCallback(() => {
    generation.current += 1;
    setTail(null);
    setMoreFailed(false);
  }, []);

  useEffect(reset, [agent, reset]);

  const first = reads.state.data;
  const entries = [...(first?.items ?? []), ...(tail?.items ?? [])];
  const nextCursor = tail === null ? (first?.nextCursor ?? null) : tail.nextCursor;
  const hasMore = tail === null ? first?.hasMore === true : tail.hasMore;
  const known = useMemo(() => agents.state.data ?? [], [agents.state.data]);

  // Refetching the first page invalidates everything after it: the log is
  // newest-first, so a tail fetched from the old cursor either repeats rows or
  // skips the one the boundary moved past.
  const refresh = useCallback(() => {
    reset();
    reads.reload();
  }, [reads, reset]);

  const loadMore = useCallback(async () => {
    if (nextCursor === null) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await api.listReads({
        ...(agent === undefined ? {} : { agent }),
        after: nextCursor,
      });
      if (mine !== generation.current) return;
      setTail((current) => ({
        items: [...(current?.items ?? []), ...page.items],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      }));
    } catch {
      if (mine === generation.current) setMoreFailed(true);
    } finally {
      if (mine === generation.current) setLoadingMore(false);
    }
  }, [api, agent, nextCursor]);

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h1>Read log</h1>
          <p className="muted">
            What each agent asked for, and how much came back. What it establishes is what an agent
            had seen when it acted, not what it understood.
          </p>
        </div>
        <div className="row">
          <label htmlFor="reads-agent" className="visually-hidden">
            Filter by agent
          </label>
          <select
            id="reads-agent"
            value={agent ?? ''}
            onChange={(event) =>
              navigate(
                event.target.value === ''
                  ? href.reads()
                  : href.reads(event.target.value as AgentId),
              )
            }
          >
            <option value="">Every agent</option>
            {known.map((each) => (
              <option key={each.id} value={each.id}>
                {each.displayName}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </header>

      {reads.state.error !== null && <Failure error={reads.state.error} onRetry={refresh} />}
      {reads.state.status === 'loading' && reads.state.data === null && <Loading what="reads" />}
      {reads.state.data !== null && entries.length === 0 && (
        <Empty>
          No reads recorded{agent === undefined ? '' : ' for this agent'}. An agent that only writes
          never appears here, which is normal.
        </Empty>
      )}

      {entries.length > 0 && <ReadLogRows entries={entries} />}

      {hasMore && nextCursor !== null && (
        <div className="row load-more">
          <button
            type="button"
            className="btn"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load older rows'}
          </button>
          {moreFailed && <span className="muted small">That did not load. Try again.</span>}
        </div>
      )}
    </section>
  );
}
