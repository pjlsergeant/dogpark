/**
 * A list that arrives newest-first in pages: the first page reloads on a
 * filter change or a Refresh, later pages accumulate beneath it.
 *
 * Refetching the first page invalidates everything after it — a tail fetched
 * from the old cursor would either repeat rows or skip the one the boundary
 * moved past — so every reset discards the tail, and a page that was already
 * out when a reset happened discards itself rather than appending rows that
 * belong to a list this screen is no longer showing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../api/index.js';
import { useAsync } from './useAsync.js';
import type { Async } from './useAsync.js';

export interface Pages<T, P extends Page<T>> {
  /** The first page, with whatever else the endpoint put beside the items. */
  readonly first: Async<P>;
  /** Every item loaded so far, first page first. */
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly refresh: () => void;
}

export function usePages<T, P extends Page<T>>(
  load: (after: string | undefined) => Promise<P>,
  deps: readonly unknown[],
): Pages<T, P> {
  const first = useAsync(() => load(undefined), deps);
  const [tail, setTail] = useState<Page<T> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const generation = useRef(0);

  const reset = useCallback(() => {
    generation.current += 1;
    setTail(null);
    setMoreFailed(false);
  }, []);

  // The dependency list is the contract, as with useEffect.
  useEffect(reset, deps);

  const data = first.state.data;
  const nextCursor = tail === null ? (data?.nextCursor ?? null) : tail.nextCursor;
  const hasMore = tail === null ? data?.hasMore === true : tail.hasMore;

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    void load(nextCursor).then(
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
  }, [load, nextCursor]);

  const refresh = useCallback(() => {
    reset();
    first.reload();
  }, [first, reset]);

  return {
    first: first.state,
    items: [...(data?.items ?? []), ...(tail?.items ?? [])],
    hasMore: hasMore && nextCursor !== null,
    loadMore,
    loadingMore,
    moreFailed,
    refresh,
  };
}
