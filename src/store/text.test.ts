import { describe, expect, it } from 'vitest';
import { normalizeTimestamp } from './text.js';

describe('normalizeTimestamp', () => {
  it('normalises ISO-8601 forms to the stored shape', () => {
    expect(normalizeTimestamp('since', '2026-08-30T10:35:00Z')).toBe('2026-08-30T10:35:00.000Z');
    expect(normalizeTimestamp('since', '2026-08-30T12:35+02:00')).toBe('2026-08-30T10:35:00.000Z');
    expect(normalizeTimestamp('since', '2026-08-30')).toBe('2026-08-30T00:00:00.000Z');
  });

  it('refuses forms Date.parse would accept but the contract never offered', () => {
    for (const value of ['08/30/2026', 'August 30, 2026', '2026-08-30 10:35', '1756550100000']) {
      expect(() => normalizeTimestamp('since', value)).toThrow('not an ISO-8601 timestamp');
    }
  });

  it('refuses the right shape on an impossible date rather than rolling it forward', () => {
    for (const value of [
      '2026-13-01T00:00:00Z',
      '2026-02-30',
      '2026-02-29T12:00:00Z',
      '2026-04-31',
      '2026-08-00',
      '2026-08-30T25:00:00Z',
      '2026-08-30T10:00:00+25:00',
    ]) {
      expect(() => normalizeTimestamp('until', value)).toThrow('not a valid ISO-8601 timestamp');
    }
    // A leap day in a leap year is a real day.
    expect(normalizeTimestamp('until', '2024-02-29')).toBe('2024-02-29T00:00:00.000Z');
  });
});
