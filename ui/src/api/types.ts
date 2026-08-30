/**
 * The admin API as this UI understands it.
 *
 * Domain types come from `src/types.ts` and are imported, never redefined.
 * What is declared here is the *admin* surface, which `docs/http-api.md`
 * names but does not give bodies for: every type below annotated
 * `@contract-gap` is an assumption the UI had to make. They are collected in
 * one file so the server can be reconciled against them in one reading.
 */
import type {
  Agent,
  AgentId,
  Attachment,
  AttachmentId,
  Conversation,
  ConversationId,
  Cursor,
  ErrorCode,
  Message,
  MessageId,
  QueryCursor,
  Space,
  SpaceId,
  Timestamp,
} from '../../../src/types.js';

export type {
  Agent,
  AgentId,
  Attachment,
  AttachmentId,
  Conversation,
  ConversationId,
  Cursor,
  Message,
  MessageId,
  QueryCursor,
  Space,
  SpaceId,
  Timestamp,
};

/** An id for one API key. Keys are revocable individually. */
export type ApiKeyId = string & { readonly __brand: 'ApiKeyId' };
export type EscalationId = string & { readonly __brand: 'EscalationId' };
export type ReadLogId = string & { readonly __brand: 'ReadLogId' };

/**
 * A `DogparkError` that reached the client, with the transport status it
 * arrived on. `status` is not part of the contract's error body; it is what
 * the UI has to route on when a body is missing or unparseable.
 */
export class ApiError extends Error {
  readonly code: ErrorCode | 'network' | 'unknown';
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(args: {
    code: ErrorCode | 'network' | 'unknown';
    message: string;
    status: number;
    retryAfterSeconds?: number | undefined;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.code = args.code;
    this.status = args.status;
    this.retryAfterSeconds = args.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * `POST /api/admin/session` — "password in, cookie + CSRF token out".
 *
 * @contract-gap The field names are not written down. `displayName` is the
 * human's configured `DOGPARK_DISPLAY_NAME`, which the UI needs to attribute
 * its own messages before it has posted one; `expiresAt` lets the UI warn
 * before a fixed-lifetime session dies rather than failing a post.
 */
export interface SessionCredentials {
  readonly csrfToken: string;
  readonly displayName?: string | undefined;
  readonly expiresAt?: Timestamp | undefined;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * `GET /api/admin/agents` — "with last-seen, and failed attempts claiming
 * each id".
 *
 * @contract-gap `Agent` in the protocol is `{ id, displayName }`; the admin
 * list needs the rest, all of which the schema already holds. Whether the
 * list includes archived agents is unspecified, so the UI asks for them
 * explicitly and tolerates a server that ignores the parameter.
 */
export interface AdminAgent extends Agent {
  readonly archived: boolean;
  readonly createdAt: Timestamp;
  /** Null until the agent has authenticated successfully at least once. */
  readonly lastSeenAt: Timestamp | null;
  /**
   * Attempts claiming this id — not attempts *by* this agent. Anyone who
   * knows an id can send a bad key bearing it.
   */
  readonly failedAuthAttempts: number;
  /**
   * @contract-gap Nothing enumerates an agent's keys, yet
   * `DELETE /agents/:id/keys/:keyId` needs a `keyId` the human can only have
   * got from such a list. Assumed to ride along with the agent.
   */
  readonly keys: readonly ApiKeySummary[];
}

export interface ApiKeySummary {
  readonly id: ApiKeyId;
  readonly label: string | null;
  readonly createdAt: Timestamp;
  readonly revokedAt: Timestamp | null;
}

/**
 * The one moment a key exists in plaintext. Returned by `POST /agents`,
 * `POST /agents/:id/keys` and `POST /agents/:id/unarchive`.
 */
export interface IssuedKey {
  readonly agent: AdminAgent;
  readonly keyId: ApiKeyId;
  /** `dgp_<agent-id>_<secret>`. Never retrievable again. */
  readonly key: string;
}

// ---------------------------------------------------------------------------
// Spaces and membership
// ---------------------------------------------------------------------------

/**
 * `GET /api/admin/spaces/:id/members` — "current members, and past
 * intervals".
 *
 * @contract-gap Membership is append-only intervals (ADR-0011), so the
 * honest shape is the intervals plus a derived current set. `current` is
 * exactly the intervals with `revokedAt === null`, sent separately so the UI
 * does not have to trust itself to derive it.
 */
export interface SpaceMembers {
  readonly space: Space;
  readonly current: readonly Agent[];
  readonly intervals: readonly MembershipInterval[];
}

export interface MembershipInterval {
  readonly agent: Agent;
  readonly grantedAt: Timestamp;
  readonly revokedAt: Timestamp | null;
}

/**
 * @contract-gap `GET /spaces/:id/conversations` is "the human's thread list",
 * which is useless without something to sort and scan by. `Conversation`
 * alone has no activity, so the counts below are assumed.
 */
export interface ConversationSummary extends Conversation {
  readonly messageCount: number;
  readonly lastMessageAt: Timestamp | null;
  /** Display name of whoever posted last, for the thread list. */
  readonly lastSenderName: string | null;
}

// ---------------------------------------------------------------------------
// Posting as the human
// ---------------------------------------------------------------------------

/**
 * `POST /api/admin/messages`.
 *
 * @contract-gap Assumed to be `PostRequest` minus the agent-shaped parts:
 * the same `PostTarget`, the same idempotency key (which the UI mints per
 * composer submission so a double-click cannot double-post), and files as
 * multipart in the same `request`-part-then-files form as the agent route.
 * The contract only describes multipart for `POST /api/agent/messages`.
 */
export interface HumanPostRequest {
  readonly target:
    { readonly conversation: ConversationId } | { readonly space: SpaceId; readonly title: string };
  readonly body: string;
  readonly idempotencyKey: string;
  readonly files?: readonly File[] | undefined;
}

export interface HumanPostResult {
  readonly message: Message;
  readonly conversation: Conversation;
}

// ---------------------------------------------------------------------------
// The read log
// ---------------------------------------------------------------------------

/**
 * One row per read call (ADR-0005): which agent, when, with which parameters,
 * and how many items came back.
 *
 * @contract-gap Field names and the shape of `params` are unspecified. The
 * UI treats `params` as opaque JSON and renders it structurally, so a server
 * that records something richer than `ReadFrom` still displays.
 */
export interface ReadLogEntry {
  readonly id: ReadLogId;
  readonly agent: Agent;
  readonly readAt: Timestamp;
  readonly kind: 'stream' | 'conversation' | 'space';
  readonly params: Readonly<Record<string, unknown>>;
  readonly cursor: string;
  readonly itemCount: number;
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export type NotificationState = 'pending' | 'sent' | 'failed';

/**
 * @contract-gap The conversation is carried by id in `EscalateRequest`; the
 * inbox is unreadable without its title and space, so those are assumed to
 * be resolved server-side. Retry state comes straight from the schema.
 */
export interface Escalation {
  readonly id: EscalationId;
  readonly agent: Agent;
  readonly conversation: Conversation;
  readonly spaceName: string;
  readonly reason: string;
  readonly createdAt: Timestamp;
  readonly notificationState: NotificationState;
  readonly attempts: number;
  readonly lastAttemptAt: Timestamp | null;
  readonly nextAttemptAt: Timestamp | null;
  readonly lastError: string | null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * @contract-gap `GET /search` says only `q`. A result has to link into the
 * reader, so it carries its whole message; `snippet` is FTS5's `snippet()`
 * output if the server offers one, and the UI falls back to the body if not.
 * Snippets are agent-authored text and are rendered as plain text, never as
 * markup.
 */
export interface SearchResult {
  readonly message: Message;
  readonly spaceName: string;
  readonly snippet: string | null;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * @contract-gap The protocol pages messages with `{ nextCursor, hasMore }`
 * (`MessagePage`). Nothing says how `/reads`, `/escalations` or `/search`
 * page, so the UI assumes the same envelope with the items under `items`,
 * and its client normalises a bare array into one.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface MessagesPage {
  readonly messages: readonly Message[];
  readonly nextCursor: QueryCursor | null;
  readonly hasMore: boolean;
}

export interface ReadLogFilter {
  readonly agent?: AgentId | undefined;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SearchQuery {
  readonly q: string;
  readonly space?: SpaceId | undefined;
  readonly after?: string | undefined;
}
