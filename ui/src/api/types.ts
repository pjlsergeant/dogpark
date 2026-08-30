/**
 * The admin API as this UI understands it.
 *
 * Domain types come from `src/types.ts` and are imported, never redefined.
 * What is declared here is the *admin* surface. The response shapes pinned in
 * `docs/http-api.md` ("Admin response shapes") are followed exactly; anything
 * marked `@contract-gap` is a field or a whole endpoint the UI needed and the
 * contract does not describe, and every such field is optional so a server
 * built strictly to the contract still renders.
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
  Sender,
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

export type EscalationId = string & { readonly __brand: 'EscalationId' };

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

/** `POST /session -> { csrfToken }`. */
export interface SessionCredentials {
  readonly csrfToken: string;
  /**
   * @contract-gap The human has a configured display name and no user record.
   * Nothing hands it to the UI, so the shell cannot say who is signed in. It
   * does not guess.
   */
  readonly displayName?: string | undefined;
  /**
   * @contract-gap Sessions have a fixed lifetime. Without an expiry the UI
   * cannot warn before one ends; it finds out by a write failing.
   */
  readonly expiresAt?: Timestamp | undefined;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * `GET /agents -> [{ id, displayName, archived, lastSeenAt,
 * failedAttemptsClaimingId, hasEverAuthenticated }]`.
 */
export interface AdminAgent extends Agent {
  readonly archived: boolean;
  /** Null until the agent has authenticated successfully at least once. */
  readonly lastSeenAt: Timestamp | null;
  /**
   * Attempts claiming this id -- not attempts *by* this agent. Anyone who
   * knows an id can send a bad key bearing it.
   */
  readonly failedAttemptsClaimingId: number;
  /** Whether the count above is still diagnostic, or just noise. */
  readonly hasEverAuthenticated: boolean;
  /** @contract-gap Not in the pinned shape; shown when a server sends it. */
  readonly createdAt?: Timestamp | undefined;
  /**
   * @contract-gap Nothing enumerates an agent's keys, yet
   * `DELETE /agents/:id/keys/:keyId` needs a `keyId` the human can only have
   * got from such a list. Where this is absent the UI can only offer to
   * revoke keys it watched being issued in this session.
   */
  readonly keys?: readonly ApiKeySummary[] | undefined;
}

export interface ApiKeySummary {
  readonly id: string;
  readonly label?: string | null | undefined;
  readonly createdAt?: Timestamp | undefined;
  readonly revokedAt?: Timestamp | null | undefined;
}

/**
 * The one moment a key exists in plaintext:
 * `POST /agents -> { agent, key }`, `POST /agents/:id/keys -> { keyId, key }`.
 */
export interface IssuedKey {
  /** `dgp_<agent-id>_<secret>`. Never retrievable again. */
  readonly key: string;
  /** Present on `POST /agents/:id/keys`. */
  readonly keyId?: string | undefined;
  /** Present on `POST /agents`. */
  readonly agent?: Agent | undefined;
}

// ---------------------------------------------------------------------------
// Spaces and membership
// ---------------------------------------------------------------------------

/**
 * `GET /spaces/:id/members -> { current: [{ agent, grantedAt }],
 * history: [{ agent, grantedAt, revokedAt }] }`.
 *
 * @contract-gap The response does not carry the space, so a screen showing
 * one space's members takes its name from `GET /spaces`.
 */
export interface SpaceMembers {
  readonly current: readonly CurrentMembership[];
  readonly history: readonly PastMembership[];
}

export interface CurrentMembership {
  readonly agent: Agent;
  readonly grantedAt: Timestamp;
}

export interface PastMembership {
  readonly agent: Agent;
  readonly grantedAt: Timestamp;
  readonly revokedAt: Timestamp;
}

/**
 * `GET /spaces/:id/conversations` -- "the human's thread list".
 *
 * @contract-gap No shape is pinned. A thread list needs something to sort and
 * scan by, and `Conversation` alone has none, so these are read when present
 * and left out of the display when not.
 */
export interface ConversationSummary extends Conversation {
  readonly messageCount?: number | undefined;
  readonly lastActivityAt?: Timestamp | null | undefined;
  readonly lastSender?: Sender | null | undefined;
}

// ---------------------------------------------------------------------------
// Posting as the human
// ---------------------------------------------------------------------------

/**
 * `POST /messages -> PostResult`.
 *
 * @contract-gap The request body is not pinned. Assumed to be `PostRequest`
 * minus the agent-shaped parts: the same `PostTarget`, the same idempotency
 * key, and files as multipart in the same `request`-part-then-files form as
 * the agent route -- which the contract describes only for
 * `POST /api/agent/messages`.
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

/** `GET /reads -> [{ agent, at, parameters, cursor, itemCount }]`. */
export interface ReadLogEntry {
  readonly agent: Agent;
  readonly at: Timestamp;
  /** Opaque JSON, rendered structurally so a richer record still displays. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly cursor: string;
  readonly itemCount: number;
  /** @contract-gap The store records a kind; the response shape drops it. */
  readonly kind?: 'stream' | 'conversation' | 'space' | undefined;
  /** @contract-gap No row id, so the list is keyed positionally. */
  readonly id?: string | undefined;
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export type NotificationState = 'pending' | 'sent' | 'failed';

/**
 * @contract-gap `notification` is named but not described. Everything past
 * `state` is retry detail the store already holds, and is displayed when the
 * server sends it. A bare string is accepted too.
 */
export interface NotificationStatus {
  readonly state: NotificationState;
  readonly attempts?: number | undefined;
  readonly lastAttemptAt?: Timestamp | null | undefined;
  readonly nextAttemptAt?: Timestamp | null | undefined;
  readonly lastError?: string | null | undefined;
}

/**
 * `GET /escalations -> [{ id, agent, conversation, reason, raisedAt,
 * notification }]`.
 */
export interface Escalation {
  readonly id: EscalationId;
  readonly agent: Agent;
  readonly conversation: Conversation;
  readonly reason: string;
  readonly raisedAt: Timestamp;
  readonly notification: NotificationStatus | NotificationState;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * `GET /search?q= -> [{ message, conversation, space }]`.
 *
 * @contract-gap No snippet, so the excerpt is cut from the body client-side,
 * and no highlight. Snippets and bodies alike are agent-authored and are
 * rendered as plain text.
 */
export interface SearchResult {
  readonly message: Message;
  readonly conversation: Conversation;
  readonly space: Space;
  readonly snippet?: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * @contract-gap `/reads`, `/escalations` and `/search` are pinned as bare
 * arrays: no cursor, no limit, no filter beyond `q` and the read log's agent.
 * The client accepts a `{ items, nextCursor, hasMore }` envelope as well, so
 * paging can be added without touching a screen.
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
  /** @contract-gap Only `q` is documented; a space filter is sent hopefully. */
  readonly space?: SpaceId | undefined;
  readonly after?: string | undefined;
}
