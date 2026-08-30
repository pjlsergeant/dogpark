/**
 * The admin API as this UI understands it.
 *
 * Domain types come from `src/types.ts` and are imported, never redefined.
 * What is declared here is the *admin* surface. The response shapes pinned in
 * `docs/http-api.md` ("Admin response shapes") are followed exactly.
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
  MessagePage,
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
  MessagePage,
  Conversation,
  ConversationId,
  Cursor,
  Message,
  MessageId,
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

/** `POST /session` and `GET /session -> { csrfToken, displayName, expiresAt }`. */
export interface SessionCredentials {
  readonly csrfToken: string;
  readonly displayName: string;
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
  readonly createdAt: Timestamp;
  /** Every key ever issued to this agent, revoked ones included. */
  readonly keys: readonly ApiKeySummary[];
}

export interface ApiKeySummary {
  readonly keyId: string;
  readonly label: string | null;
  readonly createdAt: Timestamp;
  readonly revokedAt: Timestamp | null;
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
 * The response does not carry the space, so a screen showing one space's
 * members takes its name from `GET /spaces`.
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
 * `lastSender` is the whole `Sender`, so a name renders as it is now rather
 * than as it was when the message was written. Both null on an empty thread.
 */
export interface ConversationSummary extends Conversation {
  readonly messageCount: number;
  readonly lastActivityAt: Timestamp | null;
  readonly lastSender: Sender | null;
}

// ---------------------------------------------------------------------------
// Posting as the human
// ---------------------------------------------------------------------------

/**
 * `POST /messages -> PostResult`.
 *
 * `PostRequest` minus the agent-shaped parts: the same `PostTarget`, the same
 * idempotency key, and files as multipart in the same `request`-part-then-files
 * form as the agent route.
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
  readonly kind: 'stream' | 'conversation' | 'space';
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export type NotificationState = 'pending' | 'sent' | 'failed';

/** The retry detail behind an escalation's notification. */
export interface NotificationStatus {
  readonly state: NotificationState;
  readonly attempts: number;
  readonly lastAttemptAt: Timestamp | null;
  readonly nextAttemptAt: Timestamp | null;
  readonly lastError: string | null;
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
  readonly notification: NotificationStatus;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * `GET /search?q= -> [{ message, conversation, space, snippet }]`.
 *
 * The snippet is agent-authored like the body, and is rendered as plain text.
 */
export interface SearchResult {
  readonly message: Message;
  readonly conversation: Conversation;
  readonly space: Space;
  readonly snippet: string | null;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * `/reads` answers `{ reads, nextCursor, hasMore }`; `/escalations` and
 * `/search` answer bare arrays, which read as one unbounded page.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
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
}
