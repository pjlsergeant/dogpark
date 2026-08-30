/**
 * A list that arrives in pages: the first page belongs to the current filter,
 * later pages accumulate beneath it.
 *
 * Every filter change or Refresh starts a new generation. The tail is
 * discarded at once — a page fetched from the old cursor would either repeat
 * rows or skip the one the boundary moved past — and so is the first page
 * when the filter changed, since rows from another filter under new controls
 * are a lie. A page that was already in flight when the generation moved on
 * discards itself rather than landing in a list it does not belong to.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../api/index.js';
import { toApiError } from './useAsync.js';
import type { Async } from './useAsync.js';

export interface Pages<T, P extends Page<T>> {
  /** The first page, with whatever else the endpoint put beside the items. */
  readonly first: Async<P>;
  /** Every item loaded so far, first page first. */
  readonly items: readonly T[];
  readonly hasMore: boolean;
  /** A first page or a further one is in flight; nothing more should be asked for. */
  readonly busy: boolean;
  /**
   * Later pages have been loaded. A refresh discards them, so a screen that
   * refreshes itself on a change signal should hold off while this is true —
   * the same rule the Reader's poll keys on — and leave it to the person's
   * own Refresh.
   */
  readonly paged: boolean;
  readonly loadMore: () => void;
  readonly moreFailed: boolean;
  readonly refresh: () => void;
}

export function usePages<T, P extends Page<T>>(
  load: (after: string | undefined) => Promise<P>,
  deps: readonly unknown[],
): Pages<T, P> {
  const [first, setFirst] = useState<Async<P>>({ status: 'loading', data: null, error: null });
  const [tail, setTail] = useState<Page<T> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const generation = useRef(0);
  const [nonce, setNonce] = useState(0);
  /** The loader the last first page was fetched with: a new one is a new filter. */
  const lastRun = useRef<typeof load | null>(null);

  // The caller's closure changes every render; the dependency list is the
  // contract, exactly as with useEffect.
  const run = useCallback(load, deps);

  useEffect(() => {
    const mine = (generation.current += 1);
    setTail(null);
    setMoreFailed(false);
    setLoadingMore(false);
    // A Refresh keeps the old rows on screen while the new ones come; a
    // filter change does not, because rows from another filter under the
    // new controls are a lie.
    const filterChanged = lastRun.current !== run;
    lastRun.current = run;
    setFirst((previous) => ({
      status: 'loading',
      data: filterChanged ? null : previous.data,
      error: null,
    }));
    run(undefined).then(
      (data) => {
        if (mine === generation.current) setFirst({ status: 'ready', data, error: null });
      },
      (cause: unknown) => {
        if (mine === generation.current) {
          setFirst((previous) => ({
            status: 'failed',
            data: previous.data,
            error: toApiError(cause),
          }));
        }
      },
    );
  }, [run, nonce]);

  const data = first.data;
  const nextCursor = tail === null ? (data?.nextCursor ?? null) : tail.nextCursor;
  const hasMore = tail === null ? data?.hasMore === true : tail.hasMore;
  const busy = first.status === 'loading' || loadingMore;

  const loadMore = useCallback(() => {
    if (nextCursor === null || busy) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    void run(nextCursor).then(
      (page) => {
        if (mine !== generation.current) return;
        setTail((current) => ({
          items: [...(current?.items ?? []), ...page.items],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        }));
        setLoadingMore(false);
      },
      () => {
        if (mine !== generation.current) return;
        setMoreFailed(true);
        setLoadingMore(false);
      },
    );
  }, [run, nextCursor, busy]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    first,
    items: [...(data?.items ?? []), ...(tail?.items ?? [])],
    hasMore: hasMore && nextCursor !== null,
    busy,
    paged: tail !== null,
    loadMore,
    moreFailed,
    refresh,
  };
}
