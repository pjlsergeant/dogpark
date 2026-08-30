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
}

const WINDOW_MS = 60_000;

export function createRateLimiter(perMinute: number, now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();

  /** The window's live entries, pruned and stored back. */
  const window = (key: string, at: number): number[] => {
    const cutoff = at - WINDOW_MS;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    hits.set(key, recent);
    return recent;
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
      return verdict(window(key, at), at);
    },

    record(key) {
      const at = now();
      const recent = window(key, at);
      // Same rule as `check`: an over-budget key stops accumulating, so the
      // recovery point cannot be pushed out by the flood it is refusing.
      if (recent.length < perMinute) recent.push(at);
    },
  };
}
