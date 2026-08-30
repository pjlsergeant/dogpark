import { z } from 'zod';
import type { ReadLogCursor } from '../store/index.js';
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
import { invalid } from './errors.js';

/**
 * Request validation. Ids are not pattern-checked here: an id the store does
 * not know is `not_found`, and a stricter answer for a malformed one would
 * tell a prober that its guess was at least the right shape.
 */
const Id = z.string().min(1).max(128);

export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const path = first?.path.join('.') ?? '';
  const detail =
    first === undefined ? 'is not valid' : `${path === '' ? '' : `${path}: `}${first.message}`;
  throw invalid(`${what} ${detail}`);
}

const Target = z.union([
  z.strictObject({ conversation: Id }),
  z.strictObject({ space: Id, title: z.string().min(1) }),
]);

export const PostBody = z.strictObject({
  target: Target,
  body: z.string(),
  idempotencyKey: z.string().min(1).max(200),
});

/** The human's post. The key is optional — a browser need not mint one — and
 * durable when given, like an agent's. */
export const HumanPostBody = z.strictObject({
  target: Target,
  body: z.string(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const EscalateBody = z.strictObject({
  conversation: Id,
  reason: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
});

export const NameBody = z.strictObject({ name: z.string().min(1).max(128) });
export const TitleBody = z.strictObject({ title: z.string().min(1).max(200) });
export const KeyBody = z.strictObject({ label: z.string().min(1).max(128).optional() });
export const PasswordBody = z.strictObject({ password: z.string().min(1).max(1024) });

export const StreamQuery = z.strictObject({
  after: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  tip: z.string().optional(),
  waitSeconds: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const RangeQuery = z.strictObject({
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  order: z.enum(['oldest', 'newest']).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const AgentsQuery = z.strictObject({ space: Id.optional() });

export const ReadLogQuery = z.strictObject({
  agent: Id.optional(),
  limit: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  after: z.string().optional(),
});

export const EscalationsQuery = z.strictObject({
  limit: z.coerce.number().int().positive().optional(),
});

export const SearchQuery = z.strictObject({
  q: z.string().min(1),
  space: Id.optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const TRUE = new Set(['', '1', 'true', 'yes', 'on']);

export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && TRUE.has(value.toLowerCase());
}

/**
 * `after`, `since` and `tip` are three ways to say where to start, and naming
 * two of them is a request that means two things. Rejected rather than ranked.
 */
export function readFromQuery(query: z.infer<typeof StreamQuery>): ReadFrom | undefined {
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
