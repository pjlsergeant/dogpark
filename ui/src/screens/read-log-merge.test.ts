import { describe, expect, it } from 'vitest';
import type { AgentId, ReadLogEntry } from '../api/index.js';
import { mergeReads } from './read-log-merge.js';

/** A row is only ever keyed on its id here, so the rest is filler. */
function row(id: number, extra: Partial<ReadLogEntry> = {}): ReadLogEntry {
  return {
    id: `r${id}`,
    agent: { id: 'agent0000000000' as AgentId, displayName: 'scout' },
    at: `2026-08-${String(id).padStart(2, '0')}T00:00:00.000Z` as ReadLogEntry['at'],
    parameters: {},
    cursor: `c${id}`,
    itemCount: 1,
    kind: 'stream',
    ...extra,
  };
}

/** The rows of a `merged` result, or a failure if it was not one. */
function rowsOf(result: ReturnType<typeof mergeReads>): readonly ReadLogEntry[] {
  if (result.kind !== 'merged') throw new Error(`expected merged, got ${result.kind}`);
  return result.rows;
}

const ids = (rows: readonly ReadLogEntry[]): string[] => rows.map((r) => r.id);

describe('mergeReads', () => {
  it('takes the fetched page whole when nothing is held yet', () => {
    const fetched = [row(3), row(2), row(1)];
    expect(ids(rowsOf(mergeReads([], fetched)))).toEqual(['r3', 'r2', 'r1']);
  });

  it('prepends only the rows not already held, newest first', () => {
    const existing = [row(3), row(2), row(1)];
    // A newer row landed; the fetched newest page still overlaps the head.
    const fetched = [row(5), row(4), row(3), row(2)];
    expect(ids(rowsOf(mergeReads(existing, fetched)))).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
  });

  it('reports unchanged when the page brings nothing new', () => {
    const existing = [row(3), row(2), row(1)];
    const fetched = [row(3), row(2)];
    expect(mergeReads(existing, fetched)).toEqual({ kind: 'unchanged' });
  });

  it('signals a gap, distinct from unchanged, when the page and the held list share nothing', () => {
    // More than a page arrived since the last look: prepending would leave a
    // hole in the middle, so the poll must decide — refresh, or sit still.
    const existing = [row(3), row(2), row(1)];
    const fetched = [row(9), row(8), row(7)];
    expect(mergeReads(existing, fetched)).toEqual({ kind: 'gap' });
  });

  it('never repeats a row already on screen', () => {
    const existing = [row(2), row(1)];
    const fetched = [row(3), row(2)];
    const merged = rowsOf(mergeReads(existing, fetched));
    expect(ids(merged)).toEqual(['r3', 'r2', 'r1']);
    expect(new Set(ids(merged)).size).toBe(merged.length);
  });

  it('replaces a held row re-fetched with a moved collapsedCount, fresh data winning', () => {
    // A compaction sweep swallowed more empty polls into this row: same id, but
    // a higher collapsedCount and an earlier firstReadAt. The re-fetch wins.
    const existing = [row(2, { collapsedCount: 3 }), row(1)];
    const fetched = [
      row(2, { collapsedCount: 5, firstReadAt: '2026-08-01T00:00:00.000Z' as ReadLogEntry['at'] }),
    ];
    const merged = rowsOf(mergeReads(existing, fetched));
    expect(ids(merged)).toEqual(['r2', 'r1']);
    expect(merged[0]?.collapsedCount).toBe(5);
    expect(merged[0]?.firstReadAt).toBe('2026-08-01T00:00:00.000Z');
  });
});
