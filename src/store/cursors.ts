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
