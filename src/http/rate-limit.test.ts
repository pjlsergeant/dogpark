import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000;
  return { now: () => at, advance: (ms) => (at += ms) };
}

describe('the rate limiter forgets what it no longer needs', () => {
  it('drops a key once its window has emptied', () => {
    const c = clock();
    const limiter = createRateLimiter(5, c.now);
    limiter.record('ip:10.0.0.1');
    expect(limiter.size()).toBe(1);
    c.advance(60_001);
    // Asking after the window is what finds it empty.
    expect(limiter.peek('ip:10.0.0.1').allowed).toBe(true);
    expect(limiter.size()).toBe(0);
  });

  it('creates nothing when merely asked', () => {
    const limiter = createRateLimiter(5, clock().now);
    for (let i = 0; i < 1000; i += 1) expect(limiter.peek(`id:stranger-${i}`).allowed).toBe(true);
    expect(limiter.size()).toBe(0);
  });

  it('sweeps keys nobody asked about again, once a window has passed', () => {
    const c = clock();
    const limiter = createRateLimiter(5, c.now);
    for (let i = 0; i < 1000; i += 1) limiter.record(`ip:10.0.${Math.floor(i / 256)}.${i % 256}`);
    expect(limiter.size()).toBe(1000);
    c.advance(60_001);
    // One unrelated request is enough: the sweep rides on ordinary traffic.
    limiter.check('agent');
    expect(limiter.size()).toBe(1);
  });

  it('still counts and refuses as before', () => {
    const c = clock();
    const limiter = createRateLimiter(2, c.now);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    const refused = limiter.check('k');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);
    c.advance(60_001);
    expect(limiter.check('k').allowed).toBe(true);
  });
});
