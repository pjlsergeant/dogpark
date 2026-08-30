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
  check(key: string): RateVerdict;
}

const WINDOW_MS = 60_000;

export function createRateLimiter(perMinute: number, now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const at = now();
      const cutoff = at - WINDOW_MS;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

      if (recent.length >= perMinute) {
        // The window is kept unchanged: a refused request must not push the
        // recovery point further out, or a hot client never recovers.
        hits.set(key, recent);
        const oldest = recent[0] ?? at;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - at) / 1000)),
        };
      }

      recent.push(at);
      hits.set(key, recent);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
