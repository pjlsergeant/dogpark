/**
 * Wakes long polls when something is written.
 *
 * One process holds every writer, so a write can tell the waiters directly
 * rather than each of them re-querying on a timer. A timeout is still the
 * backstop: a waiter that is never signalled returns empty on schedule, which
 * is what `waitSeconds` promises.
 */
export class WriteSignal {
  #waiters = new Set<() => void>();

  notify(): void {
    const waiting = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiting) wake();
  }

  /** Resolves on the next write, when `ms` elapses, or when `abort` fires. */
  wait(ms: number, abort?: AbortSignal | undefined): Promise<void> {
    if (ms <= 0 || abort?.aborted === true) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(finish);
        abort?.removeEventListener('abort', finish);
        resolve();
      };
      // Unreferenced so a waiting request never holds the process open past a
      // shutdown; the request's own socket keeps the event loop alive.
      const timer = setTimeout(finish, ms);
      timer.unref();
      this.#waiters.add(finish);
      abort?.addEventListener('abort', finish, { once: true });
    });
  }
}
