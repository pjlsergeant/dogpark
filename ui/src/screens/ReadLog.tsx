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

/**
 * The most live rows the poll will hold ahead of the first page. On a busy
 * instance the tail would otherwise grow without bound; past this, a poll that
 * is not reading history falls back to the honest full reload instead.
 */
const LIVE_CAP = 300;

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

  /**
   * Every filter change gets a number, and unmount takes the next one. A poll
   * that was already out when one happened lands into a view it no longer
   * belongs to, so it discards its result rather than dropping the previous
   * filter's rows into the new one.
   */
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setLive([]);
    return () => {
      generation.current += 1;
    };
  }, [agent]);

  // What is on screen now, newest first. The poll folds against this whole
  // list, and a live row that the first page has since caught up with is
  // dropped here so it cannot render twice.
  const shown = useMemo<readonly ReadLogEntry[]>(() => {
    if (live.length === 0) return pages.items;
    const paged = new Set(pages.items.map((entry) => entry.id));
    return [...live.filter((entry) => !paged.has(entry.id)), ...pages.items];
  }, [live, pages.items]);

  // Refresh is the honest full reload: drop the live tail and let the paged
  // list fetch its first page anew. It advances the generation too — a poll
  // already out is a snapshot of the pre-refresh log, and merging it afterwards
  // could resurrect rows a compaction deleted or roll fresh metadata back.
  const refresh = useCallback(() => {
    generation.current += 1;
    setLive([]);
    pages.refresh();
  }, [pages]);

  // The poll runs from a timer, so it reads the current rows, load state and
  // the honest reload through refs rather than closing over a stale render.
  const liveRef = useRef(live);
  liveRef.current = live;
  const pagedRef = useRef(pages.items);
  pagedRef.current = pages.items;
  const loadingRef = useRef(false);
  loadingRef.current = pages.first.status === 'loading';
  // Whether the human has paged back into history, and whether the first page
  // is showing a Failure: both decide what a poll does with what it finds.
  const pagedBackRef = useRef(pages.paged);
  pagedBackRef.current = pages.paged;
  const firstErrorRef = useRef(pages.first.error);
  firstErrorRef.current = pages.first.error;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const polling = useRef(false);

  const poll = useCallback(async () => {
    // Nothing to do in the background, mid-reload, or on top of a poll still
    // out; the interval will come round again.
    if (polling.current || loadingRef.current || document.visibilityState !== 'visible') return;
    polling.current = true;
    const mine = generation.current;
    try {
      const page = await api.listReads({ ...(agent === undefined ? {} : { agent }) });
      // The filter moved, or the screen unmounted, while this was out.
      if (mine !== generation.current) return;
      // A poll that succeeds while the first page is stuck behind a Failure
      // banner must recover the screen visibly, not quietly stack live rows
      // behind an error that never clears.
      if (firstErrorRef.current !== null) {
        refreshRef.current();
        return;
      }
      const seen = [...liveRef.current, ...pagedRef.current];
      const result = mergeReads(seen, page.items);
      if (result.kind === 'unchanged') return;
      // A gap the poll cannot bridge without a hole. If the human is at the
      // tip, catch the screen up honestly rather than leaving it silently
      // behind; if they have paged back into history, leave it to their Refresh.
      if (result.kind === 'gap') {
        if (!pagedBackRef.current) refreshRef.current();
        return;
      }
      // result is [...fresh, ...seen]; keep the part ahead of the first page.
      const next = result.rows.slice(0, result.rows.length - pagedRef.current.length);
      // Past the cap, the tail would grow without bound: reload honestly at the
      // tip, or, when reading history, keep what is held rather than piling on.
      if (next.length > LIVE_CAP) {
        if (!pagedBackRef.current) refreshRef.current();
        return;
      }
      setLive(next);
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
