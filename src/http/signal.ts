import { randomBytes } from 'node:crypto';

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
  /** Random per process, so a count that restarted from zero never equals one from before. */
  readonly #epoch = randomBytes(4).toString('hex');
  #count = 0;

  /**
   * An opaque token that changes on every write signalled since the process
   * started. A caller that remembers the last value it saw can tell whether
   * one landed between two of its requests, which a bare wake-up cannot say —
   * and a restart, which resets the count, still reads as a change, because
   * the epoch in front of it is new.
   */
  get version(): string {
    return `${this.#epoch}:${this.#count}`;
  }

  notify(): void {
    this.#count += 1;
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
