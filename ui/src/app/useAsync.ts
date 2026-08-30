/**
 * Load something from the API into a screen.
 *
 * Deliberately thin: a status, the data, the error, and a way to ask again.
 * Stale responses are dropped, so a fast click through spaces cannot leave
 * the previous space's members on screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/index.js';

export type Async<T> =
  | { readonly status: 'loading'; readonly data: T | null; readonly error: null }
  | { readonly status: 'ready'; readonly data: T; readonly error: null }
  | { readonly status: 'failed'; readonly data: T | null; readonly error: ApiError };

export interface AsyncResult<T> {
  readonly state: Async<T>;
  readonly reload: () => void;
}

export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError({
    code: 'unknown',
    message: cause instanceof Error ? cause.message : String(cause),
    status: 0,
  });
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [state, setState] = useState<Async<T>>({ status: 'loading', data: null, error: null });
  const [nonce, setNonce] = useState(0);

  // The caller's closure changes every render; the dependency list is the
  // contract, exactly as with useEffect.
  const run = useCallback(load, deps);

  useEffect(() => {
    let live = true;
    setState((previous) => ({ status: 'loading', data: previous.data, error: null }));
    run().then(
      (data) => {
        if (live) setState({ status: 'ready', data, error: null });
      },
      (cause: unknown) => {
        if (live) {
          setState((previous) => ({
            status: 'failed',
            data: previous.data,
            error: toApiError(cause),
          }));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [run, nonce]);

  return {
    state,
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}
