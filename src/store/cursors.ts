import type { Cursor, QueryCursor } from '../types.js';
import { invalid } from './errors.js';

/**
 * Cursors are opaque to callers: a position in the stream sequence, wrapped so
 * that nobody does arithmetic on it or reads it as a timestamp.
 *
 * Stream and query cursors carry different tags as well as different brands,
 * so handing a `readStream` cursor to `readSpace` fails at runtime and not
 * just at compile time — the HTTP layer receives both as bare strings.
 */
const STREAM_TAG = 'dgs1';
const QUERY_TAG = 'dgq1';

function encode(tag: string, seq: number): string {
  return Buffer.from(`${tag}:${seq}`, 'utf8').toString('base64url');
}

function decode(tag: string, kind: string, value: string): number {
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const [found, digits, ...rest] = text.split(':');
  if (found !== tag || rest.length > 0 || digits === undefined || !/^\d+$/.test(digits)) {
    throw invalid(`not a valid ${kind} cursor`);
  }
  const seq = Number(digits);
  if (!Number.isSafeInteger(seq)) throw invalid(`not a valid ${kind} cursor`);
  return seq;
}

export function encodeCursor(seq: number): Cursor {
  return encode(STREAM_TAG, seq) as Cursor;
}

export function decodeCursor(cursor: Cursor): number {
  return decode(STREAM_TAG, 'stream', cursor);
}

export function encodeQueryCursor(seq: number): QueryCursor {
  return encode(QUERY_TAG, seq) as QueryCursor;
}

export function decodeQueryCursor(cursor: QueryCursor): number {
  return decode(QUERY_TAG, 'query', cursor);
}

/**
 * A position in the read log.
 *
 * Its own brand and its own tag, like the other two: the read log is ordered
 * by when a read happened, not by the stream sequence, so a cursor from it
 * means nothing to `readStream` or `readSpace` and vice versa.
 *
 * `Cursor` and `QueryCursor` are protocol types, in `src/types.ts`. This one
 * is not: the read log is the admin surface, so the brand lives here.
 */
export type ReadLogCursor = string & { readonly __brand: 'ReadLogCursor' };

const READ_LOG_TAG = 'dgl1';

/**
 * Two components, because `read_at` alone is not unique — a page of reads
 * recorded in the same millisecond would either repeat rows or skip them. The
 * rowid breaks the tie, and the log is append-only so it never moves.
 */
export interface ReadLogPosition {
  readonly readAt: string;
  readonly rowId: number;
}

export function encodeReadLogCursor(position: ReadLogPosition): ReadLogCursor {
  // The rowid comes first, so the timestamp — the only part containing a `:` —
  // is whatever is left after the first two separators.
  return Buffer.from(`${READ_LOG_TAG}:${position.rowId}:${position.readAt}`, 'utf8').toString(
    'base64url',
  ) as ReadLogCursor;
}

export function decodeReadLogCursor(cursor: ReadLogCursor): ReadLogPosition {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = text.split(':');
  const [found, digits] = parts;
  const readAt = parts.slice(2).join(':');
  if (found !== READ_LOG_TAG || digits === undefined || !/^\d+$/.test(digits) || readAt === '') {
    throw invalid('not a valid read log cursor');
  }
  const rowId = Number(digits);
  if (!Number.isSafeInteger(rowId)) throw invalid('not a valid read log cursor');
  return { readAt, rowId };
}
