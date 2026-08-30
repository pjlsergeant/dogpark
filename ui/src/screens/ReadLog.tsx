/**
 * The read log: one row per read call, with the parameters it read with.
 *
 * The question this screen answers is "had this agent seen the instruction
 * when it acted?". Recording the parameters is what makes that answerable: a
 * cursor at the head means the agent is *here*, not that it was handed
 * everything behind here, so a seek has to be visibly a seek (ADR-0005).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentId, ReadLogEntry } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { href, navigate } from '../app/router.js';
import { absoluteTime } from '../app/format.js';
import { Empty, Failure, Id, Loading, Pill, Time } from '../components/bits.js';

/** `from: tip` discards the backlog: the agent did not see what was behind it. */
function isSeekToTip(entry: ReadLogEntry): boolean {
  return entry.parameters['from'] === 'tip';
}

function Params({ params }: { params: Readonly<Record<string, unknown>> }): ReactNode {
  const entries = Object.entries(params);
  if (entries.length === 0) return <span className="muted">from the beginning</span>;
  return (
    <span className="params">
      {entries.map(([name, value]) => (
        <span className="param" key={name}>
          <span className="param-name">{name}</span>
          <span className="param-value">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </span>
        </span>
      ))}
    </span>
  );
}

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

  useEffect(() => {
    setTail(null);
    setMoreFailed(false);
  }, [agent]);

  const first = reads.state.data;
  const entries = [...(first?.items ?? []), ...(tail?.items ?? [])];
  const nextCursor = tail === null ? (first?.nextCursor ?? null) : tail.nextCursor;
  const hasMore = tail === null ? first?.hasMore === true : tail.hasMore;
  const known = useMemo(() => agents.state.data ?? [], [agents.state.data]);

  const loadMore = useCallback(async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await api.listReads({
        ...(agent === undefined ? {} : { agent }),
        after: nextCursor,
      });
      setTail((current) => ({
        items: [...(current?.items ?? []), ...page.items],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      }));
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
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
          <button type="button" className="btn" onClick={reads.reload}>
            Refresh
          </button>
        </div>
      </header>

      {reads.state.error !== null && <Failure error={reads.state.error} onRetry={reads.reload} />}
      {reads.state.status === 'loading' && reads.state.data === null && <Loading what="reads" />}
      {reads.state.data !== null && entries.length === 0 && (
        <Empty>
          No reads recorded{agent === undefined ? '' : ' for this agent'}. An agent that only writes
          never appears here, which is normal.
        </Empty>
      )}

      {entries.length > 0 && (
        <table className="table table-log">
          <thead>
            <tr>
              <th>When</th>
              <th>Agent</th>
              <th>Kind</th>
              <th>Read with</th>
              <th className="numeric">Items</th>
              <th>Cursor returned</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={entry.id ?? index}>
                <td title={absoluteTime(entry.at)}>
                  <Time iso={entry.at} />
                </td>
                <td>
                  <a href={href.agents(entry.agent.id)}>{entry.agent.displayName}</a>
                </td>
                <td>
                  {entry.kind !== undefined && (
                    <Pill tone={entry.kind === 'stream' ? 'info' : 'muted'}>{entry.kind}</Pill>
                  )}
                  {isSeekToTip(entry) && (
                    <span
                      className="jump"
                      title="Started at the live edge, discarding everything behind it. This read is a jump, not a span."
                    >
                      jump
                    </span>
                  )}
                </td>
                <td>
                  <Params params={entry.parameters} />
                </td>
                <td className="numeric">{entry.itemCount}</td>
                <td>
                  <Id value={entry.cursor} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
