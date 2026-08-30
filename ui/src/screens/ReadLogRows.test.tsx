/**
 * The jump badge is the visual distinction ADR-0005 is built around, and a
 * predicate that never fires leaves a screen that still looks complete.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentId, ReadLogEntry } from '../api/index.js';
import { isSeekToTip, ReadLogRows } from './ReadLogRows.js';

function entry(parameters: Record<string, unknown>, id: string): ReadLogEntry {
  return {
    id,
    agent: { id: 'agent0000000000a' as AgentId, displayName: 'alpha' },
    at: '2026-08-30T10:00:00.000Z' as ReadLogEntry['at'],
    parameters,
    cursor: 'c-42',
    itemCount: 0,
    kind: 'stream',
  };
}

describe('the read log rows', () => {
  // The store records the stream's `from` argument as given: a tip seek is
  // `{ from: { from: 'tip' } }`, one level down from where a flat check looks.
  const tipSeek = entry({ from: { from: 'tip' }, limit: 100 }, 'r1');
  const span = entry({ from: { after: 'c-41' }, limit: 100 }, 'r2');
  const fromStart = entry({ from: null, limit: 100 }, 'r3');

  it('tells a tip seek from a span', () => {
    expect(isSeekToTip(tipSeek)).toBe(true);
    expect(isSeekToTip(span)).toBe(false);
    expect(isSeekToTip(fromStart)).toBe(false);
    expect(isSeekToTip(entry({ from: 'tip' }, 'r4'))).toBe(false);
  });

  it('renders the jump badge on a tip seek and on nothing else', () => {
    const html = renderToStaticMarkup(<ReadLogRows entries={[tipSeek, span, fromStart]} />);
    expect(html.match(/class="jump"/g)).toHaveLength(1);
    const rows = html.split('<tr>').slice(2);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('class="jump"');
    expect(rows[1]).not.toContain('class="jump"');
    expect(rows[2]).not.toContain('class="jump"');
  });

  it('shows a collapsed row as a span, saying how many polls it stands for', () => {
    const collapsed: ReadLogEntry = {
      ...entry({ from: { after: 'c-41' }, limit: 100 }, 'r5'),
      collapsedCount: 12,
      firstReadAt: '2026-08-30T09:00:00.000Z' as ReadLogEntry['at'],
    };
    const html = renderToStaticMarkup(<ReadLogRows entries={[collapsed, span]} />);
    const rows = html.split('<tr>').slice(2);
    expect(rows[0]).toContain('2026-08-30T09:00:00.000Z');
    expect(rows[0]).toContain('×12');
    // An ordinary row still reads as one read, at one moment.
    expect(rows[1]).not.toContain('×');
    expect(rows[1]).not.toContain('2026-08-30T09:00:00.000Z');
  });
});
