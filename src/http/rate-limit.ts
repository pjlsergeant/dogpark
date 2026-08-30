/**
 * Per-agent request rate, from `Limits.requestsPerMinute`.
 *
 * In memory, because Dogpark is one process by design (ADR-0008). A sliding
 * window rather than a fixed one: a fixed window lets an agent spend a whole
 * minute's budget either side of the boundary, which is exactly the burst the
 * limit exists to stop.
 */
export interface RateVerdict {
  readonly allowed: boolean;
  /** Whole seconds until the oldest request in the window falls out of it. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Asks and spends: the ordinary case, where the request is about to happen. */
  check(key: string): RateVerdict;
  /**
   * Asks without spending. For a cost that is only incurred by *some* of the
   * requests asking — failed authentication, where a valid key must not be
   * charged for the invalid ones.
   */
  peek(key: string): RateVerdict;
  /** Spends without asking, for a cost discovered after the fact. */
  record(key: string): void;
  /** How many keys are being remembered. For tests and metrics, not verdicts. */
  size(): number;
}

const WINDOW_MS = 60_000;

export function createRateLimiter(perMinute: number, now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = now();

  /**
   * The window's live entries. A key whose window has emptied is forgotten
   * rather than kept as an empty list: the failed-auth keys carry the source
   * address and whatever id a stranger claimed, so remembering every one ever
   * seen would be memory growth driven by input that need not be valid.
   */
  const prune = (key: string, at: number): number[] => {
    const cutoff = at - WINDOW_MS;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) hits.delete(key);
    return recent;
  };

  /** Pruned and stored back, for a caller about to add to it. */
  const window = (key: string, at: number): number[] => {
    sweep(at);
    const recent = prune(key, at);
    hits.set(key, recent);
    return recent;
  };

  /**
   * A key that is hit once and never asked about again is never pruned by
   * `prune`, so once a window has passed every key is walked. Once per
   * window, so the walk is amortised over at least as many requests.
   */
  const sweep = (at: number): void => {
    if (at - lastSweep < WINDOW_MS) return;
    lastSweep = at;
    for (const key of [...hits.keys()]) prune(key, at);
  };

  const verdict = (recent: readonly number[], at: number): RateVerdict => {
    if (recent.length < perMinute) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = recent[0] ?? at;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - at) / 1000)),
    };
  };

  return {
    check(key) {
      const at = now();
      const recent = window(key, at);
      const answer = verdict(recent, at);
      // The window is kept unchanged when refusing: a refused request must not
      // push the recovery point further out, or a hot client never recovers.
      if (answer.allowed) recent.push(at);
      return answer;
    },

    peek(key) {
      const at = now();
      // Asking creates nothing: a key never charged is a key never stored.
      return verdict(prune(key, at), at);
    },

    record(key) {
      const at = now();
      const recent = window(key, at);
      // Same rule as `check`: an over-budget key stops accumulating, so the
      // recovery point cannot be pushed out by the flood it is refusing.
      if (recent.length < perMinute) recent.push(at);
    },

    size() {
      return hits.size;
    },
  };
}
