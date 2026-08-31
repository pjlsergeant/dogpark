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
  ConversationAnnotations,
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
import type { EmptyStreamReadRow } from './statements.js';

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

/** A space as the human's list shows it: how much is in it, and when it last moved. */
export interface SpaceSummary extends Space {
  readonly conversationCount: number;
  readonly messageCount: number;
  /** When the last message in any of its threads landed. Null for a space nobody has posted in. */
  readonly lastActivityAt: Timestamp | null;
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
  readonly complete?: true | undefined;
  readonly pin?: true | undefined;
}

export interface PostMessageResult {
  readonly message: Message;
  readonly conversation: Conversation;
  /** False when an idempotency key replayed an earlier write. */
  readonly created: boolean;
  readonly annotations: ConversationAnnotations;
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
  /** When the human settled it; null while it still waits for one. */
  readonly acknowledgedAt: Timestamp | null;
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
  readonly annotations: ConversationAnnotations;
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
  /**
   * How many reads this row stands for. 1 for an ordinary row; more when a
   * sweep compacted a run of empty stream polls into their last read, which
   * is this one.
   */
  readonly collapsedCount: number;
  /** When that run began. Absent on a row that stands only for itself. */
  readonly firstReadAt?: Timestamp | undefined;
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

/**
 * One agent's surviving row on its way from one collapse batch to the next,
 * and whether the run it stands for has already been counted.
 */
export interface CollapseSeed {
  readonly row: EmptyStreamReadRow;
  readonly counted: boolean;
}

/**
 * Where a collapse sweep got to. Opaque to callers: hand it back verbatim to
 * continue the sweep, and read nothing out of it. It carries the keyset
 * position and each agent's surviving row, so a run split at a batch boundary
 * can be rejoined — and counted once.
 */
export interface CollapseResume {
  readonly afterRow: number;
  readonly seeds: ReadonlyMap<string, CollapseSeed>;
}

export interface CollapseBatch {
  /** Logical runs compacted by this call. */
  readonly collapsed: number;
  /** Rows this call deleted. */
  readonly removed: number;
  /** Whether the walk reached the end; until it does, call again with `resume`. */
  readonly done: boolean;
  readonly resume: CollapseResume;
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
  /** Every space with its counts, for the human's list. */
  listSpaceSummaries(): readonly SpaceSummary[];
  getSpace(space: SpaceId): Space | undefined;
  grantMembership(agent: AgentId, space: SpaceId): boolean;
  revokeMembership(agent: AgentId, space: SpaceId): boolean;
  isCurrentMember(agent: AgentId, space: SpaceId): boolean;
  listSpacesForAgent(agent: AgentId): readonly Space[];
  listMembershipIntervals(filter?: {
    readonly agent?: AgentId | undefined;
    readonly space?: SpaceId | undefined;
  }): readonly MembershipInterval[];
  setSpaceDescription(space: SpaceId, body: string): void;
  getSpaceDescription(space: SpaceId): string | undefined;
  setAgentDescription(agent: AgentId, body: string): void;
  getAgentDescription(agent: AgentId): string | undefined;
  setMembershipNote(agent: AgentId, space: SpaceId, body: string): void;
  getMembershipNote(agent: AgentId, space: SpaceId): string | undefined;

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
  getConversationAnnotations(conversation: ConversationId): ConversationAnnotations;
  getConversationAnnotationsAsOf(
    conversation: ConversationId,
    tip: number,
    labelSeq?: number,
  ): ConversationAnnotations;
  completeConversation(
    actor: Reader,
    conversation: ConversationId,
    idempotencyKey?: IdempotencyKey,
  ): boolean;
  reopenConversation(
    actor: Reader,
    conversation: ConversationId,
    idempotencyKey?: IdempotencyKey,
  ): boolean;
  pinMessage(
    actor: Reader,
    conversation: ConversationId,
    message: MessageId,
    idempotencyKey?: IdempotencyKey,
  ): boolean;
  unpinConversation(
    actor: Reader,
    conversation: ConversationId,
    idempotencyKey?: IdempotencyKey,
  ): boolean;

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
   * A page of a conversation as it read at a given read-log row — the same
   * query as `readConversation` for the human, rendered with the labels in
   * force then, and bounded at the read's own moment: nothing sent after the
   * read is included, since the agent could not have seen it. The bound is
   * the stream tip the row recorded, so a row that recorded one is exact —
   * including a recorded tip of 0, a read of a stream nothing had been written
   * to yet. A row that recorded no tip falls back to the read's millisecond,
   * and a message sent later in that same millisecond is shown.
   *
   * Bounded by membership too: if the read's agent held no membership in the
   * conversation's space at that moment, the agent could have seen nothing of
   * it, so this is undefined — the honest contract is what the agent could
   * have seen, not what the thread now holds. Not a read: nothing is logged.
   * Undefined if the read or the conversation is unknown.
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
  /** Rows the webhook has not delivered: delivery detail, not the headline. */
  countUndeliveredEscalations(): number;
  /** Rows nobody has settled: what the inbox badge counts, whatever page it shows. */
  countUnacknowledgedEscalations(): number;
  markEscalationNotification(
    escalation: string,
    state: NotificationState,
    options?: {
      readonly error?: string | undefined;
      readonly nextAttemptAt?: Timestamp | undefined;
    },
  ): EscalationRecord;
  /**
   * Settle an escalation. Idempotent: a second ack keeps the first one's time
   * and still succeeds. Returns the settled record, or undefined for an id
   * that names no escalation.
   */
  acknowledgeEscalation(escalation: string): EscalationRecord | undefined;

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
  /**
   * Compacts runs of consecutive empty stream polls older than `olderThan`.
   * An idle agent long-polling writes thousands of rows a day that record
   * nothing but its patience; a run where each poll resumed exactly where the
   * last left off collapses into its final row, which keeps its own id,
   * timestamp, cursor and parameters and gains `collapsedCount` and
   * `firstReadAt` saying what it stands for. Nothing that returned content,
   * and no read of any other kind, is ever touched — so this is a summary,
   * not a retention policy. `collapsed` counts the runs compacted — logical
   * runs, so a sweep reports the same number whatever the batch size — and
   * `removed` the rows that went; both are per call, and a caller running a
   * whole sweep sums them.
   *
   * One call is one batch, so neither memory, nor any one transaction, nor the
   * time the event loop is held, grows with the log. Until `done`, call again
   * with the `resume` just returned — between calls the caller is free, which
   * is how a backlog of months is swept without stalling the server.
   * `batchSize` is how many candidates a batch holds; it defaults to a size no
   * ordinary sweep reaches and exists so a test can cross a batch boundary
   * without writing thousands of rows.
   */
  collapseEmptyStreamReads(
    olderThan: Timestamp,
    options?: {
      readonly batchSize?: number | undefined;
      readonly resume?: CollapseResume | undefined;
    },
  ): CollapseBatch;

  // Sessions
  createSession(ttlSeconds: number): IssuedSession;
  verifySession(token: string): SessionRecord | undefined;
  deleteSession(token: string): boolean;
  deleteExpiredSessions(): number;
  /**
   * Notices a change of the configured password hash, and revokes every
   * session when it has changed — a rotation is the moment existing cookies
   * stop being trusted. Returns how many were revoked: 0 when the hash is
   * unchanged. The first start to record a fingerprint revokes too, since it
   * cannot tell an upgrade from an upgrade that also rotated the password; a
   * fresh database has no sessions and so loses nothing. What is stored is a
   * hash *of* the hash, so the table never holds the verifier itself.
   */
  syncPasswordFingerprint(passwordHash: string): number;
}
