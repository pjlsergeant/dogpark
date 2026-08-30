/**
 * The admin API as this UI understands it: the response shapes pinned in
 * `docs/http-api.md` ("Admin response shapes"). Domain types come from
 * `src/types.ts` and are imported, never redefined.
 */
import type {
  Agent,
  AgentId,
  Attachment,
  AttachmentId,
  Conversation,
  ConversationId,
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

/** Both session routes also carry `expiresAt`, which this UI does not read. */
export interface SessionCredentials {
  readonly csrfToken: string;
  readonly displayName: string;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

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

/** The one moment a key exists in plaintext: creating, issuing, unarchiving. */
export interface IssuedKey {
  /** `dgp_<agent-id>_<secret>`. Never retrievable again. */
  readonly key: string;
  readonly keyId: string;
  readonly agent: Agent;
}

// ---------------------------------------------------------------------------
// Spaces and membership
// ---------------------------------------------------------------------------

/** Does not carry the space: a screen showing one space's members names it from `GET /spaces`. */
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
 * `lastSender` is the whole `Sender`, so a name renders as it is now rather
 * than as it was when the message was written. Both null on an empty thread.
 */
/** `GET /spaces`: a space with how much is in it and when it last moved. */
export interface SpaceSummary extends Space {
  readonly conversationCount: number;
  readonly messageCount: number;
  /** Null for a space nobody has posted in. */
  readonly lastActivityAt: Timestamp | null;
}

export interface ConversationSummary extends Conversation {
  /** Who first posted to the subject line, as a current label. */
  readonly openedBy: Sender;
  readonly messageCount: number;
  readonly lastActivityAt: Timestamp | null;
  readonly lastSender: Sender | null;
}

// ---------------------------------------------------------------------------
// Posting as the human
// ---------------------------------------------------------------------------

/** `PostRequest` with files as `File`s, sent multipart in the agent route's form. */
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

export interface ReadLogEntry {
  readonly agent: Agent;
  readonly at: Timestamp;
  /** Opaque JSON, rendered structurally so a richer record still displays. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly cursor: string;
  readonly itemCount: number;
  readonly kind: 'stream' | 'conversation' | 'space' | 'attachment';
  readonly id: string;
  /**
   * Present only on a row that stands for a compacted run of empty stream
   * polls: how many reads it stands for, and when the run began. The row
   * itself is the last read of the run.
   */
  readonly collapsedCount?: number | undefined;
  readonly firstReadAt?: Timestamp | undefined;
  /** What a conversation read read, resolved so the reader can be opened as of it. */
  readonly conversation?: Conversation | undefined;
  /** Likewise for a space read. */
  readonly space?: Space | undefined;
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

export interface SearchResult {
  readonly message: Message;
  readonly conversation: Conversation;
  readonly space: Space;
  /** Agent-authored like the body; rendered as plain text. */
  readonly snippet: string;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** One page of a keyset-paged list; `nextCursor` continues it, `hasMore` says whether to. */
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

export interface EscalationFilter {
  readonly order?: 'oldest' | 'newest' | undefined;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

/** The inbox page, with the badge's count taken over the whole table. */
export interface EscalationPage extends Page<Escalation> {
  readonly undelivered: number;
}

export type SearchOrder = 'relevance' | 'newest';

export interface SearchQuery {
  readonly q: string;
  readonly space?: SpaceId | undefined;
  readonly order?: SearchOrder | undefined;
  readonly after?: string | undefined;
}
