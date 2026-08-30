/**
 * One long poll for the whole app.
 *
 * `GET /changes` is held open until something is written — a post, a
 * membership change, a rename, a roster or key change, an escalation — and
 * every screen showing something a write can move
 * refreshes itself when it returns. One request rather than one per screen,
 * and none while the tab is in the background, where there is nothing to keep
 * fresh; on coming back the version last seen is sent, so anything written
 * meanwhile answers at once. A server that cannot be reached is retried after
 * a pause rather than hammered.
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DogparkAdminApi } from '../api/index.js';

const WAIT_SECONDS = 30;
const RETRY_MS = 5_000;

/** Bumped on every change seen. Its value means nothing; a difference does. */
const ChangesContext = createContext(0);

export function ChangesProvider({
  api,
  children,
}: {
  api: DogparkAdminApi;
  children: ReactNode;
}): ReactNode {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let last: string | undefined;
    let stopped = false;
    let running = false;
    let controller: AbortController | null = null;
    const pause = (ms: number): Promise<void> =>
      new Promise((resolve) => window.setTimeout(resolve, ms));

    async function run(): Promise<void> {
      if (running) return;
      running = true;
      try {
        while (!stopped && document.visibilityState === 'visible') {
          controller = new AbortController();
          try {
            const next = await api.awaitChanges(last, WAIT_SECONDS, controller.signal);
            if (stopped) return;
            // The first answer counts too: screens load on their own, so a
            // write between a screen's first fetch and this baseline would
            // otherwise be invisible until the next one. One extra refresh at
            // start-up is the price of not missing it.
            if (next !== last) setTick((n) => n + 1);
            last = next;
          } catch {
            // Abandoned on purpose — the tab went to the background, or the
            // app is going — or the server is unreachable: either way not a
            // reason to spin.
            if (stopped || controller.signal.aborted) return;
            await pause(RETRY_MS);
          }
        }
      } finally {
        running = false;
      }
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void run();
      else controller?.abort();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void run();
    return () => {
      stopped = true;
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api]);

  return <ChangesContext.Provider value={tick}>{children}</ChangesContext.Provider>;
}

/**
 * Runs `callback` each time a change is seen after this component mounted.
 * The latest callback is used, so it may close over anything; and the tick
 * standing at mount is not a change, so a screen that has just loaded does
 * not immediately load again.
 */
export function useOnChange(callback: () => void): void {
  const tick = useContext(ChangesContext);
  const seen = useRef(tick);
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (tick === seen.current) return;
    seen.current = tick;
    latest.current();
  }, [tick]);
}
