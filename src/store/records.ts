/**
 * Public shapes of the store that the protocol (`src/types.ts`) does not
 * already name: what the HTTP layer and the UI's admin surface see.
 */
import type {
  Agent,
  AgentId,
  AttachmentId,
  Conversation,
  ConversationId,
  IdempotencyKey,
  Message,
  PostTarget,
  ReadFrom,
  Sender,
  SpaceId,
  Timestamp,
} from '../types.js';
import type { ReadLogCursor } from './cursors.js';

/**
 * Who is reading or writing. The human has no agent row, so the union is not
 * `AgentId?`; nor is the human bound by membership.
 */
export type Reader = { readonly kind: 'agent'; readonly id: AgentId } | { readonly kind: 'human' };

export interface AgentRecord extends Agent {
  readonly archived: boolean;
  readonly createdAt: Timestamp;
  readonly lastSeenAt: Timestamp | null;
  /**
   * Attempts claiming this id, which is what it is: anyone who knows an id can
   * send a bad key bearing it. Separate from `lastSeenAt` — a failure is not a
   * sighting.
   */
  readonly failedAuthAttempts: number;
}

export interface IssuedKey {
  readonly id: string;
  readonly agent: AgentId;
  /** The only time this exists. Nothing stores it; only its hash is kept. */
  readonly key: string;
  readonly createdAt: Timestamp;
}

export interface KeyRecord {
  readonly id: string;
  readonly agent: AgentId;
  readonly label: string | null;
  readonly createdAt: Timestamp;
  readonly revokedAt: Timestamp | null;
}

export interface MembershipInterval {
  readonly id: string;
  readonly agent: AgentId;
  readonly space: SpaceId;
  readonly grantedAt: Timestamp;
  readonly revokedAt: Timestamp | null;
}

export interface AttachmentInput {
  /**
   * Supplied by the caller, because the file is written to the volume under
   * this id *before* the message row commits — a crash then leaves an
   * unreferenced file rather than a message pointing at nothing.
   */
  readonly id: AttachmentId;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /**
   * A digest of the bytes, if the caller has one. Not stored: it goes into the
   * idempotency request hash, so a retry that uploads a different file under
   * the same name, type and size is a different request. The store never sees
   * the bytes; the caller hashes them on the way to the volume.
   */
  readonly contentDigest?: string | undefined;
}

export interface PostMessageInput {
  readonly sender: Reader;
  readonly target: PostTarget;
  readonly body: string;
  readonly attachments?: readonly AttachmentInput[] | undefined;
  /** Scoped per writer: each agent, and the human (schema.sql). */
  readonly idempotencyKey?: IdempotencyKey | undefined;
}

export interface PostMessageResult {
  readonly message: Message;
  readonly conversation: Conversation;
  /** False when an idempotency key replayed an earlier write. */
  readonly created: boolean;
}

export interface ReadStreamArgs {
  readonly from?: ReadFrom | undefined;
  readonly limit?: number | undefined;
}

export type NotificationState = 'pending' | 'sent' | 'failed';

export interface EscalationRecord {
  readonly id: string;
  readonly agent: AgentId;
  readonly conversation: ConversationId;
  readonly reason: string;
  readonly createdAt: Timestamp;
  readonly notificationState: NotificationState;
  readonly attempts: number;
  readonly lastAttemptAt: Timestamp | null;
  readonly nextAttemptAt: Timestamp | null;
  readonly lastError: string | null;
}

export interface RecordEscalationInput {
  readonly agent: AgentId;
  readonly conversation: ConversationId;
  readonly reason: string;
  readonly idempotencyKey: IdempotencyKey;
}

export interface EscalationOutcome {
  readonly escalation: EscalationRecord;
  readonly created: boolean;
}

/**
 * A conversation plus what a thread list has to show beside it.
 *
 * Derived, never stored: a count and a maximum over the messages already
 * indexed by `(conversation_id, seq)`. The alternative — the caller reading
 * every message in the space and folding them — is a full space scan per
 * request, and it renders labels the store would render anyway.
 */
export interface ConversationSummary extends Conversation {
  readonly messageCount: number;
  /** When the last message landed. Null for a thread nobody has posted to. */
  readonly lastActivityAt: Timestamp | null;
  /**
   * Who wrote it, rendered like any other label (ADR-0014) — an agent's
   * current display name, or the human's configured one. Null with
   * `lastActivityAt`.
   */
  readonly lastSender: Sender | null;
}

/**
 * What counts as a read: message content, by stream, by conversation, by
 * space, or an attachment's bytes. `identity()` and the roster are not
 * recorded — what they return is derivable from membership history.
 */
export type ReadKind = 'stream' | 'conversation' | 'space' | 'attachment';

export interface ReadLogEntry {
  readonly id: string;
  readonly agent: AgentId;
  readonly readAt: Timestamp;
  readonly kind: ReadKind;
  /** The parameters read with. Recording them is the point (ADR-0005). */
  readonly params: unknown;
  readonly cursor: string;
  readonly itemCount: number;
}

/**
 * Which reads to return, newest first.
 *
 * `since`/`until` follow the same convention as `Range` — inclusive and
 * exclusive respectively — and bound `readAt`, not the cursor the read
 * returned.
 */
export interface ReadLogFilter {
  readonly agent?: AgentId | undefined;
  readonly since?: Timestamp | undefined;
  readonly until?: Timestamp | undefined;
  /** Position of the last entry already seen. Continues strictly older. */
  readonly after?: ReadLogCursor | undefined;
  readonly limit?: number | undefined;
}

export interface ReadLogPage {
  readonly entries: readonly ReadLogEntry[];
  /**
   * Where to continue from, which is the position of the last entry returned.
   * An empty page keeps the position it was given; null only when nothing was
   * returned and nothing was supplied — there is no position yet.
   */
  readonly nextCursor: ReadLogCursor | null;
  readonly hasMore: boolean;
}

export interface SessionRecord {
  readonly id: string;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp;
}

export interface IssuedSession extends SessionRecord {
  /** The only time this exists. Only its hash is stored. */
  readonly token: string;
}

export interface SearchHit {
  readonly message: Message;
  readonly snippet: string;
}

export interface StoreOptions {
  /** Path to the SQLite file. Parent directories are created. */
  readonly file: string;
  /** There is no user record, so the human's name comes from configuration. */
  readonly humanDisplayName: string;
  /** Injectable so tests can control ordering and expiry. */
  readonly now?: (() => Date) | undefined;
}
