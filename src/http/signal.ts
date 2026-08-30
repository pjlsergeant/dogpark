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

/**
 * The two audiences a write can wake, and which writes wake them.
 *
 * Agent stream polls must wake only for writes that put something on the
 * stream: waking one for anything else hands it an empty page and writes a
 * read-log row for a read the agent never wanted — the reason escalations
 * were originally kept off the signal entirely. The admin UI shows
 * everything, so its `/changes` poll wakes on every mutation. The two
 * methods keep that superset relationship in one place: a call site says
 * who can see the write, not which signals to poke.
 */
export class WriteSignals {
  /** What agent stream long-polls wait on. */
  readonly agent = new WriteSignal();
  /** What the admin UI's `/changes` long-poll waits on. */
  readonly admin = new WriteSignal();

  /** A write that lands on agent streams — a post, a membership change. */
  agentVisible(): void {
    this.agent.notify();
    this.admin.notify();
  }

  /**
   * A write only the human's screens show: a space or agent created or
   * renamed, a thread retitled, a key issued or revoked, an escalation.
   */
  adminOnly(): void {
    this.admin.notify();
  }
}
