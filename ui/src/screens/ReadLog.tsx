/**
 * The read log: one row per read call, with the parameters it read with.
 *
 * The question this screen answers is "had this agent seen the instruction
 * when it acted?". Recording the parameters is what makes that answerable: a
 * cursor at the head means the agent is *here*, not that it was handed
 * everything behind here, so a seek has to be visibly a seek (ADR-0005).
 *
 * A read is not a write, so it never wakes the app's `/changes` poll — the log
 * would sit still behind the signal. Instead, while it is on screen and the
 * tab is in front, it polls the newest page on its own every few seconds and
 * folds in whatever has landed, so it feels live to the human watching without
 * turning /changes into a metronome. Refresh is still the full reload.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentId, Page, ReadLogEntry } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { usePages } from '../app/usePages.js';
import { href, navigate } from '../app/router.js';
import { Empty, Failure, Loading } from '../components/bits.js';
import { LoadMore } from '../components/LoadMore.js';
import { mergeReads } from './read-log-merge.js';
import { ReadLogRows } from './ReadLogRows.js';

/** How often the live tail is checked while the tab is in front. */
const POLL_MS = 5_000;

export function ReadLogScreen({ agent }: { agent?: AgentId | undefined }): ReactNode {
  const api = useApi();
  const agents = useAsync(() => api.listAgents(), [api]);
  const pages = usePages<ReadLogEntry, Page<ReadLogEntry>>(
    (after) => api.listReads({ ...(agent === undefined ? {} : { agent }), after }),
    [api, agent],
  );
  const known = useMemo(() => agents.state.data ?? [], [agents.state.data]);

  /**
   * Rows the poll has found ahead of the first page — always the newest, since
   * the log only grows at the head. Kept apart from the paged rows so that
   * loading older pages and living at the tip do not fight over one list.
   */
  const [live, setLive] = useState<readonly ReadLogEntry[]>([]);

  // A filter change starts a clean list; the paged rows reset themselves.
  useEffect(() => setLive([]), [agent]);

  // What is on screen now, newest first. The poll folds against this whole
  // list, and a live row that the first page has since caught up with is
  // dropped here so it cannot render twice.
  const shown = useMemo<readonly ReadLogEntry[]>(() => {
    if (live.length === 0) return pages.items;
    const paged = new Set(pages.items.map((entry) => entry.id));
    return [...live.filter((entry) => !paged.has(entry.id)), ...pages.items];
  }, [live, pages.items]);

  // The poll runs from a timer, so it reads the current paged rows and load
  // state through refs rather than closing over a stale render.
  const pagedRef = useRef(pages.items);
  pagedRef.current = pages.items;
  const loadingRef = useRef(false);
  loadingRef.current = pages.first.status === 'loading';
  const polling = useRef(false);

  const poll = useCallback(async () => {
    // Nothing to do in the background, mid-reload, or on top of a poll still
    // out; the interval will come round again.
    if (polling.current || loadingRef.current || document.visibilityState !== 'visible') return;
    polling.current = true;
    try {
      const page = await api.listReads({ ...(agent === undefined ? {} : { agent }) });
      setLive((current) => {
        const seen = [...current, ...pagedRef.current];
        const merged = mergeReads(seen, page.items);
        // Unchanged (nothing new, or a gap left to Refresh): keep what we hold.
        if (merged === seen) return current;
        // merged is [...fresh, ...seen]; keep the part ahead of the first page.
        const next = merged.slice(0, merged.length - pagedRef.current.length);
        // An empty log hands back a fresh empty array each poll; do not let that
        // churn a render out of nothing.
        if (next.length === 0 && current.length === 0) return current;
        return next;
      });
    } catch {
      // A poll that fails is a poll that fails; the next tick tries again.
    } finally {
      polling.current = false;
    }
  }, [api, agent]);

  useEffect(() => {
    const timer = globalThis.setInterval(() => void poll(), POLL_MS);
    // Poll only in front, and the moment the tab comes back, so a return does
    // not wait out a whole interval before the log catches up.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      globalThis.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  // Refresh is the honest full reload: drop the live tail and let the paged
  // list fetch its first page anew.
  const refresh = useCallback(() => {
    setLive([]);
    pages.refresh();
  }, [pages]);

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

      {pages.first.error !== null && <Failure error={pages.first.error} onRetry={refresh} />}
      {pages.first.status === 'loading' && pages.first.data === null && <Loading what="reads" />}
      {pages.first.data !== null && shown.length === 0 && (
        <Empty>
          No reads recorded{agent === undefined ? '' : ' for this agent'}. An agent that only writes
          never appears here, which is normal.
        </Empty>
      )}

      {shown.length > 0 && <ReadLogRows entries={shown} />}

      <LoadMore pages={pages} label="Load older rows" />
    </section>
  );
}
