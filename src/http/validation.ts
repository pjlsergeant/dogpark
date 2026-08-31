import { z } from 'zod';
import type { EscalationCursor, ReadLogCursor, SearchCursor } from '../store/index.js';
import type {
  AgentId,
  ConversationId,
  Cursor,
  IdempotencyKey,
  PostTarget,
  QueryCursor,
  Range,
  ReadFrom,
  SpaceId,
  Timestamp,
} from '../types.js';
import {
  AgentsQuery,
  AnnotationActionBody,
  ChangesQuery,
  CatchUpQuery,
  DescriptionBody,
  EscalateBody,
  EscalationsQuery,
  ExportQuery,
  HumanPostBody,
  HumanAnnotationActionBody,
  HumanPinBody,
  HumanReadMarkBody,
  KeyBody,
  MAX_REASON_CHARS,
  MAX_TITLE_CHARS,
  NameBody,
  PasswordBody,
  PostBody,
  PinBody,
  RangeQuery,
  ReadLogQuery,
  SearchQuery,
  StreamQuery,
  Target,
  TitleBody,
} from '../types.js';
import { invalid } from './errors.js';

/**
 * Request validation lives with the rest of the protocol in `src/types.ts`,
 * where the request schemas sit beside the response schemas they answer. This
 * module re-exports them so the routes import from one place, and adds the
 * helpers that turn a parsed query into the store's own types — helpers that
 * depend on the HTTP layer's error type and the store's cursor brands, so they
 * cannot live in the isomorphic protocol module.
 */
export {
  AgentsQuery,
  AnnotationActionBody,
  ChangesQuery,
  CatchUpQuery,
  DescriptionBody,
  EscalateBody,
  EscalationsQuery,
  ExportQuery,
  HumanPostBody,
  HumanAnnotationActionBody,
  HumanPinBody,
  HumanReadMarkBody,
  KeyBody,
  MAX_REASON_CHARS,
  MAX_TITLE_CHARS,
  NameBody,
  PasswordBody,
  PostBody,
  PinBody,
  RangeQuery,
  ReadLogQuery,
  SearchQuery,
  StreamQuery,
  Target,
  TitleBody,
};

export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const path = first?.path.join('.') ?? '';
  const detail =
    first === undefined ? 'is not valid' : `${path === '' ? '' : `${path}: `}${first.message}`;
  throw invalid(`${what} ${detail}`);
}

const TRUE = new Set(['', '1', 'true', 'yes', 'on']);

export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && TRUE.has(value.toLowerCase());
}

/**
 * `after`, `since` and `tip` are three ways to say where to start, and naming
 * two of them is a request that means two things. Rejected rather than ranked.
 */
export function readFromQuery(query: z.infer<typeof StreamQuery>): ReadFrom | undefined {
  // A present-but-falsy tip is refused rather than dropped: silently reading
  // from the beginning because someone wrote `tip=0`, or letting `tip=0`
  // slip past the one-start-only check, is answering a question nobody asked
  // (found by an agent driving the live API).
  if (query.tip !== undefined && !isTruthyFlag(query.tip)) {
    throw invalid('tip is a flag: give tip=1, or omit it');
  }
  const tip = isTruthyFlag(query.tip);
  const given = [query.after !== undefined, query.since !== undefined, tip].filter(Boolean).length;
  if (given > 1) throw invalid('give at most one of after, since or tip');
  if (query.after !== undefined) return { after: query.after as Cursor };
  if (query.since !== undefined) return { since: query.since as Timestamp };
  if (tip) return { from: 'tip' };
  return undefined;
}

/**
 * `order` is passed straight through. The store pages backwards from the end
 * for `newest` and returns each page newest-first, so nothing here has to
 * re-page a read.
 */
export function rangeFromQuery(query: z.infer<typeof RangeQuery>): Range {
  return {
    ...(query.since === undefined ? {} : { since: query.since as Timestamp }),
    ...(query.until === undefined ? {} : { until: query.until as Timestamp }),
    ...(query.after === undefined ? {} : { after: query.after as QueryCursor }),
    ...(query.order === undefined ? {} : { order: query.order }),
  };
}

export function toTarget(target: z.infer<typeof Target>): PostTarget {
  return 'conversation' in target
    ? { conversation: target.conversation as ConversationId }
    : { space: target.space as SpaceId, title: target.title };
}

export const asAgentId = (value: string): AgentId => value as AgentId;
export const asSpaceId = (value: string): SpaceId => value as SpaceId;
export const asConversationId = (value: string): ConversationId => value as ConversationId;
export const asIdempotencyKey = (value: string): IdempotencyKey => value as IdempotencyKey;
export const asTimestamp = (value: string): Timestamp => value as Timestamp;
/**
 * The read log's own cursor brand, minted by the store and handed back to it
 * unread. Cast at the boundary like the ids: what a malformed one means is the
 * store's to say, and it says `invalid_request`.
 */
export const asReadLogCursor = (value: string): ReadLogCursor => value as ReadLogCursor;
export const asEscalationCursor = (value: string): EscalationCursor => value as EscalationCursor;
export const asSearchCursor = (value: string): SearchCursor => value as SearchCursor;
