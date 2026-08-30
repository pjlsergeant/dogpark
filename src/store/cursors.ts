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

/**
 * `tag:key:timestamp`. The key comes first, so the timestamp — the only part
 * containing a `:` — is whatever is left after the first two separators.
 */
function encodeKeyed(tag: string, key: string, at: string): string {
  return Buffer.from(`${tag}:${key}:${at}`, 'utf8').toString('base64url');
}

function decodeKeyed(tag: string, kind: string, cursor: string): { key: string; at: string } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = text.split(':');
  const [found, key] = parts;
  const at = parts.slice(2).join(':');
  if (found !== tag || key === undefined || key === '' || at === '') {
    throw invalid(`not a valid ${kind} cursor`);
  }
  return { key, at };
}

export function encodeReadLogCursor(position: ReadLogPosition): ReadLogCursor {
  return encodeKeyed(READ_LOG_TAG, String(position.rowId), position.readAt) as ReadLogCursor;
}

export function decodeReadLogCursor(cursor: ReadLogCursor): ReadLogPosition {
  const { key, at } = decodeKeyed(READ_LOG_TAG, 'read log', cursor);
  if (!/^\d+$/.test(key)) throw invalid('not a valid read log cursor');
  const rowId = Number(key);
  if (!Number.isSafeInteger(rowId)) throw invalid('not a valid read log cursor');
  return { readAt: at, rowId };
}

export type ListOrder = 'oldest' | 'newest';

/**
 * A position in the escalation list: `created_at` is not unique either, and
 * the id — random, never reused — breaks the tie in both directions. The
 * cursor names the order it was taken in, because the same boundary means
 * "everything older" in one direction and "everything newer" in the other,
 * and a caller that switches order mid-walk should be told, not turned round.
 */
export type EscalationCursor = string & { readonly __brand: 'EscalationCursor' };

const ESCALATION_TAG = 'dge1';

export interface EscalationPosition {
  readonly order: ListOrder;
  readonly createdAt: string;
  readonly id: string;
}

export function encodeEscalationCursor(position: EscalationPosition): EscalationCursor {
  return Buffer.from(
    `${ESCALATION_TAG}:${position.order}:${position.id}:${position.createdAt}`,
    'utf8',
  ).toString('base64url') as EscalationCursor;
}

export function decodeEscalationCursor(cursor: EscalationCursor): EscalationPosition {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const [found, order, id, ...rest] = text.split(':');
  const createdAt = rest.join(':');
  if (
    found !== ESCALATION_TAG ||
    (order !== 'oldest' && order !== 'newest') ||
    id === undefined ||
    id === '' ||
    createdAt === ''
  ) {
    throw invalid('not a valid escalation cursor');
  }
  return { order, createdAt, id };
}

export type SearchOrder = 'relevance' | 'newest';

/**
 * A position in one search's results, in the order it names. Relevance order
 * is `(rank, seq)`, and the rank travels as the shortest decimal that reads
 * back to the same double, so the equality half of the keyset test binds the
 * value FTS5 computed. Newest order is the seq alone. A cursor from one order
 * is refused by the other: a newest cursor carries no rank, and a relevance
 * cursor's seq is not a position in time order.
 */
export type SearchCursor = string & { readonly __brand: 'SearchCursor' };

const SEARCH_TAG = 'dgf1';

export type SearchPosition =
  | { readonly order: 'relevance'; readonly seq: number; readonly rank: number }
  | { readonly order: 'newest'; readonly seq: number };

export function encodeSearchCursor(position: SearchPosition): SearchCursor {
  const text =
    position.order === 'relevance'
      ? `${SEARCH_TAG}:relevance:${position.seq}:${position.rank}`
      : `${SEARCH_TAG}:newest:${position.seq}`;
  return Buffer.from(text, 'utf8').toString('base64url') as SearchCursor;
}

const DECIMAL = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/;

export function decodeSearchCursor(cursor: SearchCursor): SearchPosition {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const [found, order, digits, rankText, ...rest] = text.split(':');
  const bad = (): never => {
    throw invalid('not a valid search cursor');
  };
  if (found !== SEARCH_TAG || rest.length > 0 || digits === undefined || !/^\d+$/.test(digits)) {
    return bad();
  }
  const seq = Number(digits);
  if (!Number.isSafeInteger(seq)) return bad();
  if (order === 'newest') return rankText === undefined ? { order, seq } : bad();
  if (order !== 'relevance' || rankText === undefined || !DECIMAL.test(rankText)) return bad();
  const rank = Number(rankText);
  return Number.isFinite(rank) ? { order, seq, rank } : bad();
}
