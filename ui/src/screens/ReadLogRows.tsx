/**
 * The read log's table, separated from the screen so the rows can be rendered
 * and asserted on without a browser: the jump badge is the visual distinction
 * ADR-0005 is built around, and a predicate that never fires is invisible in
 * a screen that always renders something.
 */
import type { ReactNode } from 'react';
import type { ReadLogEntry } from '../api/index.js';
import { href } from '../app/router.js';
import { absoluteTime } from '../app/format.js';
import { Id, Pill, Time } from '../components/bits.js';

/**
 * `from: tip` discards the backlog: the agent did not see what was behind it.
 *
 * The store records the stream's `from` argument as it was given — `{ from:
 * 'tip' }`, `{ after }`, `{ since }` or `null` — under `parameters.from`, so a
 * tip seek is one level down.
 */
export function isSeekToTip(entry: ReadLogEntry): boolean {
  const from: unknown = entry.parameters['from'];
  return typeof from === 'object' && from !== null && (from as { from?: unknown }).from === 'tip';
}

function Params({ params }: { params: Readonly<Record<string, unknown>> }): ReactNode {
  const entries = Object.entries(params);
  if (entries.length === 0) return <span className="muted">from the beginning</span>;
  return (
    <span className="params">
      {entries.map(([name, value]) => (
        <span className="param" key={name}>
          <span className="param-name">{name}</span>
          <span className="param-value">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </span>
        </span>
      ))}
    </span>
  );
}

export function ReadLogRows({ entries }: { entries: readonly ReadLogEntry[] }): ReactNode {
  return (
    <table className="table table-log">
      <thead>
        <tr>
          <th>When</th>
          <th>Agent</th>
          <th>Kind</th>
          <th>Read with</th>
          <th className="numeric">Items</th>
          <th>Cursor returned</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => (
          <tr key={entry.id ?? index}>
            <td title={absoluteTime(entry.at)}>
              <Time iso={entry.at} />
            </td>
            <td>
              <a href={href.agents(entry.agent.id)}>{entry.agent.displayName}</a>
            </td>
            <td>
              {entry.kind !== undefined && (
                <Pill tone={entry.kind === 'stream' ? 'info' : 'muted'}>{entry.kind}</Pill>
              )}
              {isSeekToTip(entry) && (
                <span
                  className="jump"
                  title="Started at the live edge, discarding everything behind it. This read is a jump, not a span."
                >
                  jump
                </span>
              )}
            </td>
            <td>
              <Params params={entry.parameters} />
            </td>
            <td className="numeric">{entry.itemCount}</td>
            <td>
              <Id value={entry.cursor} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
