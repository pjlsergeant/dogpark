/**
 * The store's public surface: the shapes the protocol (`src/types.ts`) does
 * not already name, and the `Store` interface the domain modules implement.
 */
import type { Database as Db } from 'better-sqlite3';
import type {
  Agent,
  AgentId,
  Attachment,
  AttachmentId,
  Conversation,
  ConversationId,
  Cursor,
  IdempotencyKey,
  Message,
  MessageId,
  MessagePage,
  PostTarget,
  Range,
  ReadFrom,
  Sender,
  Space,
  SpaceId,
  StreamPage,
  Timestamp,
} from '../types.js';
import type { EscalationCursor, ReadLogCursor, SearchCursor } from './cursors.js';
import type { MigrateResult } from './migrate.js';

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
 * Which escalations to return. `oldest` (the default here; the notifier's
 * walk) or `newest` (the inbox's, and the HTTP default). `after` is the
 * position of the last row already seen and continues in the direction it
 * was taken in; one from the other order is refused.
 */
export interface EscalationFilter {
  readonly state?: NotificationState | undefined;
  /** Only rows due by then: never attempted, or scheduled at or before it. */
  readonly dueAt?: Timestamp | undefined;
  readonly order?: 'oldest' | 'newest' | undefined;
  readonly after?: EscalationCursor | undefined;
  readonly limit?: number | undefined;
}

export interface EscalationPage {
  readonly escalations: readonly EscalationRecord[];
  /** As `ReadLogPage.nextCursor`: the last row's position, kept when empty. */
  readonly nextCursor: EscalationCursor | null;
  readonly hasMore: boolean;
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
  /**
   * Who opened the thread — posted to its subject line first — rendered like
   * any other label. Forensic context: why there is a thread by this name.
   */
  readonly openedBy: Sender;
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

/**
 * `relevance` (the default) is bm25 with the newer message first among
 * equals; `newest` is the sequence. A cursor is a position in the order it
 * was taken in, and the other order refuses it.
 */
export interface SearchOptions {
  readonly space?: SpaceId | undefined;
  readonly order?: 'relevance' | 'newest' | undefined;
  readonly after?: SearchCursor | undefined;
  readonly limit?: number | undefined;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  /** As the other pages: the last hit's position, kept when the page is empty. */
  readonly nextCursor: SearchCursor | null;
  readonly hasMore: boolean;
}

export interface StoreOptions {
  /** Path to the SQLite file. Parent directories are created. */
  readonly file: string;
  /** There is no user record, so the human's name comes from configuration. */
  readonly humanDisplayName: string;
  /** Injectable so tests can control ordering and expiry. */
  readonly now?: (() => Date) | undefined;
}

export interface Store {
  close(): void;
  /** Escape hatch for the HTTP layer's health check. Not for queries. */
  readonly database: Db;
  /** What `openStore` migrated the schema to on the way in. */
  readonly schema: MigrateResult;
  readonly reservedSequence: string;

  // Agents
  createAgent(displayName: string): AgentRecord;
  renameAgent(agent: AgentId, displayName: string): AgentRecord;
  archiveAgent(agent: AgentId): AgentRecord;
  unarchiveAgent(agent: AgentId): AgentRecord;
  listAgents(options?: { readonly includeArchived?: boolean | undefined }): readonly AgentRecord[];
  getAgent(agent: AgentId): AgentRecord | undefined;
  listAgentsSharingSpaceWith(agent: AgentId, space?: SpaceId | undefined): readonly Agent[];

  // Keys
  issueKey(agent: AgentId, label?: string | undefined): IssuedKey;
  /**
   * `countFailure` false verifies without charging the agent's failure
   * counter — for a caller that has decided this attempt is part of a flood
   * and should not drive public telemetry further.
   */
  verifyKey(
    presented: string,
    options?: { readonly countFailure?: boolean },
  ): AgentRecord | undefined;
  revokeKey(keyId: string): void;
  listKeys(agent: AgentId): readonly KeyRecord[];

  // Spaces and membership
  createSpace(name: string): Space;
  renameSpace(space: SpaceId, name: string): Space;
  listSpaces(): readonly Space[];
  getSpace(space: SpaceId): Space | undefined;
  grantMembership(agent: AgentId, space: SpaceId): boolean;
  revokeMembership(agent: AgentId, space: SpaceId): boolean;
  isCurrentMember(agent: AgentId, space: SpaceId): boolean;
  listSpacesForAgent(agent: AgentId): readonly Space[];
  listMembershipIntervals(filter?: {
    readonly agent?: AgentId | undefined;
    readonly space?: SpaceId | undefined;
  }): readonly MembershipInterval[];

  // Conversations
  /** Test fixtures only: production opens threads through `postMessage`. */
  resolveOrCreateConversation(
    space: SpaceId,
    title: string,
    createdBy?: Reader | undefined,
  ): Conversation;
  getConversation(conversation: ConversationId): Conversation | undefined;
  renameConversation(conversation: ConversationId, title: string): Conversation;
  /**
   * The thread list: every conversation in a space with its message count,
   * last activity and last sender, ordered by last activity. The admin
   * surface's — no call enumerates a space's conversations for an agent.
   */
  listConversationSummaries(space: SpaceId): readonly ConversationSummary[];

  // Messages
  postMessage(input: PostMessageInput): PostMessageResult;
  readStream(agent: AgentId, args?: ReadStreamArgs): StreamPage;
  /**
   * Both message queries honour `Range.order`. `oldest` pages forward from the
   * start; `newest` pages backwards from the end and returns each page
   * newest-first, so `messages[0]` is the newest message on it. `hasMore`
   * means "more in the direction you are travelling" — older ones, backwards.
   */
  readConversation(
    reader: Reader,
    conversation: ConversationId,
    range?: Range | undefined,
    limit?: number | undefined,
  ): MessagePage;
  readSpace(
    reader: Reader,
    space: SpaceId,
    range?: Range | undefined,
    limit?: number | undefined,
  ): MessagePage;
  /**
   * Relevance paging is honest but not stable across writes: bm25 weighs a
   * term against the whole corpus, so a message posted between two pages can
   * shift every rank and make the boundary skip or repeat one hit. `newest`
   * pages on the immutable sequence and has no such seam.
   */
  searchMessages(query: string, options?: SearchOptions): SearchPage;
  /**
   * Metadata only; the bytes live on the volume. Carries the space as well as
   * the message, because a file's visibility is its message's and the caller
   * would otherwise have to fetch the message just to learn which space to
   * authorise against.
   */
  getAttachment(
    attachment: AttachmentId,
  ): (Attachment & { readonly message: MessageId; readonly space: SpaceId }) | undefined;
  /**
   * One message rendered with the labels in force when a given read-log row
   * was written: the sender's name, the conversation's title and the
   * mentioned names as they stood then, from the label history (migration
   * 0002). Ordered by the history's own sequence rather than by clock, so a
   * read and a rename in the same millisecond still come out in the order
   * they happened.
   *
   * A label snapshot, not proof of inclusion: this does not check that the
   * message was on that read's page. Whether it was is a question about the
   * row's kind, parameters and cursor, which the row records; this answers
   * the other half — given that it was, what wording went out. Undefined if
   * either id is unknown.
   */
  renderAsOfRead(message: MessageId, read: string): Message | undefined;
  /**
   * A page of a conversation as it read at a given read-log row — the same
   * query as `readConversation` for the human, rendered with the labels in
   * force then, and bounded at the read's own moment: nothing sent after the
   * read's millisecond is included, since the agent could not have seen it.
   * To the millisecond only — a read row records when, not the stream tip,
   * so a message sent later in that same millisecond is shown. Not a read:
   * nothing is logged. Undefined if the read or the conversation is unknown.
   */
  readConversationAsOf(
    read: string,
    conversation: ConversationId,
    range?: Range | undefined,
    limit?: number | undefined,
  ): MessagePage | undefined;

  // Escalations
  recordEscalation(input: RecordEscalationInput): EscalationOutcome;
  listEscalations(filter?: EscalationFilter): EscalationPage;
  /** Rows not yet `sent`: what the inbox badge counts, whatever page it shows. */
  countUndeliveredEscalations(): number;
  markEscalationNotification(
    escalation: string,
    state: NotificationState,
    options?: {
      readonly error?: string | undefined;
      readonly nextAttemptAt?: Timestamp | undefined;
    },
  ): EscalationRecord;

  // The read log
  /**
   * The forensic view, newest first, filtered and paged. This is the read log
   * table's only full reader: it grows faster than anything else here, so
   * every page is bounded and resumable.
   */
  readReadLog(filter?: ReadLogFilter): ReadLogPage;
  getRead(read: string): ReadLogEntry | undefined;
  lastReadCursor(agent: AgentId): Cursor | undefined;
  /**
   * An attachment fetch is a read of content and gets its row like any other
   * (ADR-0005). Called by the route once the bytes are about to be served.
   */
  recordAttachmentRead(agent: AgentId, attachment: AttachmentId, message: MessageId): void;

  // Sessions
  createSession(ttlSeconds: number): IssuedSession;
  verifySession(token: string): SessionRecord | undefined;
  deleteSession(token: string): boolean;
  deleteExpiredSessions(): number;
}
