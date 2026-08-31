import { describe, expect, it } from 'vitest';
import type { AgentId, ReadLogEntry } from '../api/index.js';
import { mergeReads } from './read-log-merge.js';

/** A row is only ever keyed on its id here, so the rest is filler. */
function row(id: number): ReadLogEntry {
  return {
    id: `r${id}`,
    agent: { id: 'agent0000000000' as AgentId, displayName: 'scout' },
    at: `2026-08-${String(id).padStart(2, '0')}T00:00:00.000Z` as ReadLogEntry['at'],
    parameters: {},
    cursor: `c${id}`,
    itemCount: 1,
    kind: 'stream',
  };
}

const ids = (rows: readonly ReadLogEntry[]): string[] => rows.map((r) => r.id);

describe('mergeReads', () => {
  it('takes the fetched page whole when nothing is held yet', () => {
    const fetched = [row(3), row(2), row(1)];
    expect(ids(mergeReads([], fetched))).toEqual(['r3', 'r2', 'r1']);
  });

  it('prepends only the rows not already held, newest first', () => {
    const existing = [row(3), row(2), row(1)];
    // A newer row landed; the fetched newest page still overlaps the head.
    const fetched = [row(5), row(4), row(3), row(2)];
    expect(ids(mergeReads(existing, fetched))).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
  });

  it('returns the held list unchanged when the page brings nothing new', () => {
    const existing = [row(3), row(2), row(1)];
    const fetched = [row(3), row(2)];
    expect(mergeReads(existing, fetched)).toBe(existing);
  });

  it('leaves a gap to a Refresh when the page and the held list share nothing', () => {
    // More than a page arrived since the last look: prepending would leave a
    // hole in the middle, so the poll declines and the row count sits still.
    const existing = [row(3), row(2), row(1)];
    const fetched = [row(9), row(8), row(7)];
    expect(mergeReads(existing, fetched)).toBe(existing);
  });

  it('never repeats a row already on screen', () => {
    const existing = [row(2), row(1)];
    const fetched = [row(3), row(2)];
    const merged = mergeReads(existing, fetched);
    expect(ids(merged)).toEqual(['r3', 'r2', 'r1']);
    expect(new Set(ids(merged)).size).toBe(merged.length);
  });
});
