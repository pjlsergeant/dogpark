/**
 * The read log: one row per read call, with the parameters it read with.
 *
 * The question this screen answers is "had this agent seen the instruction
 * when it acted?". Recording the parameters is what makes that answerable: a
 * cursor at the head means the agent is *here*, not that it was handed
 * everything behind here, so a seek has to be visibly a seek (ADR-0005).
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { AgentId, Page, ReadLogEntry } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { usePages } from '../app/usePages.js';
import { href, navigate } from '../app/router.js';
import { Empty, Failure, Loading } from '../components/bits.js';
import { LoadMore } from '../components/LoadMore.js';
import { ReadLogRows } from './ReadLogRows.js';

export function ReadLogScreen({ agent }: { agent?: AgentId | undefined }): ReactNode {
  const api = useApi();
  const agents = useAsync(() => api.listAgents(), [api]);
  const pages = usePages<ReadLogEntry, Page<ReadLogEntry>>(
    (after) => api.listReads({ ...(agent === undefined ? {} : { agent }), after }),
    [api, agent],
  );
  const known = useMemo(() => agents.state.data ?? [], [agents.state.data]);

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
          <button type="button" className="btn" onClick={pages.refresh}>
            Refresh
          </button>
        </div>
      </header>

      {pages.first.error !== null && <Failure error={pages.first.error} onRetry={pages.refresh} />}
      {pages.first.status === 'loading' && pages.first.data === null && <Loading what="reads" />}
      {pages.first.data !== null && pages.items.length === 0 && (
        <Empty>
          No reads recorded{agent === undefined ? '' : ' for this agent'}. An agent that only writes
          never appears here, which is normal.
        </Empty>
      )}

      {pages.items.length > 0 && <ReadLogRows entries={pages.items} />}

      <LoadMore pages={pages} label="Load older rows" />
    </section>
  );
}
