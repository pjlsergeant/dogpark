import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type {
  Agent,
  AgentId,
  Attachment,
  AttachmentId,
  Conversation,
  ConversationId,
  Cursor,
  EventId,
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
  StreamItem,
  StreamPage,
  SystemEvent,
  Timestamp,
} from '../types.js';
import {
  decodeCursor,
  decodeQueryCursor,
  decodeReadLogCursor,
  encodeCursor,
  encodeQueryCursor,
  encodeReadLogCursor,
  type ReadLogCursor,
} from './cursors.js';
import { invalid, notFound, StoreError } from './errors.js';
import { KEY_PREFIX, newId, splitKey } from './ids.js';
import { migrate } from './migrate.js';
import type { MigrateResult } from './migrate.js';
import {
  assertNoReservedSequence,
  assertNonEmpty,
  assertValidName,
  encodeMentions,
  normalizeTimestamp,
  parseMentions,
  renderMentions,
  renderSnippet,
  RESERVED_SEQUENCE,
} from './text.js';

export { StoreError } from './errors.js';
export { RESERVED_SEQUENCE } from './text.js';
export { migrate, MIGRATIONS } from './migrate.js';
export type { Migration, MigrateResult } from './migrate.js';
export type { ReadLogCursor } from './cursors.js';

/**
 * Mints an id for an attachment that is about to be written.
 *
 * `AttachmentInput.id` is caller-minted on purpose — the file is written to
 * the volume under this id before the message row commits — but the alphabet
 * and the length are the store's, not the caller's. Without this export the
 * only way to satisfy the interface was to reach past it into `./ids.js`,
 * which made an internal module part of the contract by accident.
 *
 * Deliberately the only minter exported: agents, spaces, messages and
 * conversations get their ids from the store itself, and a caller that can
 * mint one of those can collide with one.
 */
export function newAttachmentId(): AttachmentId {
  return newId() as AttachmentId;
}

// ---------------------------------------------------------------------------
// Public shapes the protocol does not already name
// ---------------------------------------------------------------------------

/** Who is reading. The human has no agent row, so the union is not `AgentId?`. */
export type Reader = { readonly kind: 'agent'; readonly id: AgentId } | { readonly kind: 'human' };

/** Who is writing. The human has no agent row and is not bound by membership. */
export type Writer = Reader;

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

export interface Authentication {
  readonly agent: AgentRecord;
  readonly keyId: string;
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
   * A digest of the bytes, if the caller has one. Not stored: it exists so
   * that a retried write hashes to the same request as the original.
   *
   * Without it, two uploads agreeing on name, type and size are the same
   * request as far as an idempotency key is concerned, whatever the bytes say.
   * The caller streams those bytes to the volume and can hash them on the way
   * past; the store never sees them.
   */
  readonly contentDigest?: string | undefined;
}

export interface PostMessageInput {
  readonly sender: Writer;
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

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  display_name: string;
  archived: number;
  created_at: string;
  last_seen_at: string | null;
  failed_auth_attempts: number;
}

interface SpaceRow {
  id: string;
  name: string;
}

interface AgentNameRow {
  id: string;
  display_name: string;
}

interface ConversationRow {
  id: string;
  space_id: string;
  title: string;
}

interface MessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  space_id: string;
  sender_kind: string;
  sender_agent_id: string | null;
  body: string;
  sent_at: string;
}

interface EventRow {
  seq: number;
  id: string;
  agent_id: string;
  kind: string;
  space_id: string;
  created_at: string;
}

interface AttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

interface EscalationRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  reason: string;
  created_at: string;
  notification_state: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
}

interface ReadLogRow {
  /** The table's implicit rowid, selected explicitly: it is half the cursor. */
  row_id: number;
  id: string;
  agent_id: string;
  read_at: string;
  kind: string;
  params_json: string;
  cursor: string;
  item_count: number;
}

/** Everything the read-log statements bind apart from the agent. */
interface ReadLogBounds {
  since: string | null;
  until: string | null;
  afterAt: string | null;
  /** Only read when `afterAt` is not null, but a named parameter binds either way. */
  afterRow: number;
  limit: number;
}

interface ConversationSummaryRow extends ConversationRow {
  message_count: number;
  last_sent_at: string | null;
  last_sender_kind: string | null;
  last_sender_agent_id: string | null;
  last_sender_name: string | null;
}

interface StreamRow {
  seq: number;
  kind: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const READ_LOG_COLUMNS =
  'SELECT rowid AS row_id, id, agent_id, read_at, kind, params_json, cursor, item_count ' +
  '  FROM read_log WHERE ';

/**
 * The range, the keyset cursor and the ordering, shared by both read-log
 * statements. `read_at` is not unique, so the rowid breaks the tie and both
 * halves travel in the cursor; without that, a page taken across reads
 * recorded in the same millisecond either repeats rows or skips them.
 */
const READ_LOG_TAIL =
  '   AND (@since IS NULL OR read_at >= @since) ' +
  '   AND (@until IS NULL OR read_at < @until) ' +
  '   AND (@afterAt IS NULL OR read_at < @afterAt ' +
  '        OR (read_at = @afterAt AND rowid < @afterRow)) ' +
  ' ORDER BY read_at DESC, rowid DESC LIMIT @limit';

/** How FTS5 marks the matched tokens in a search snippet. */
const SNIPPET_OPEN = '[';
const SNIPPET_CLOSE = ']';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable field order, so the same request always hashes the same way. */
function requestHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer');
  return Math.min(limit, MAX_LIMIT);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

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
  ): Authentication | undefined;
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
  resolveOrCreateConversation(
    space: SpaceId,
    title: string,
    createdBy?: Writer | undefined,
  ): Conversation;
  getConversation(conversation: ConversationId): Conversation | undefined;
  renameConversation(conversation: ConversationId, title: string): Conversation;

  /**
   * One message as it rendered at `at`: the sender's name, the conversation's
   * title and the mentioned names are the labels in force then, from the
   * label history (migration 0002). This is what makes the read log a
   * reference rather than a copy: a row's `readAt` plus this reproduces the
   * wording an agent was handed, whatever has been renamed since.
   */
  messageAsOf(message: MessageId, at: Timestamp): Message | undefined;
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
  searchMessages(
    query: string,
    options?: {
      readonly space?: SpaceId | undefined;
      readonly limit?: number | undefined;
    },
  ): readonly SearchHit[];
  /**
   * Metadata only; the bytes live on the volume. Carries the space as well as
   * the message, because a file's visibility is its message's and the caller
   * would otherwise have to fetch the message just to learn which space to
   * authorise against.
   */
  getAttachment(
    attachment: AttachmentId,
  ): (Attachment & { readonly message: MessageId; readonly space: SpaceId }) | undefined;

  // Escalations
  recordEscalation(input: RecordEscalationInput): EscalationOutcome;
  listEscalations(filter?: {
    readonly state?: NotificationState | undefined;
    readonly dueAt?: Timestamp | undefined;
    readonly limit?: number | undefined;
  }): readonly EscalationRecord[];
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

/**
 * Who a write is idempotent for. An agent is its own id; the human is
 * `HUMAN_WRITER`, which carries a character the id alphabet does not, so no id
 * the application mints can equal it. `agent.id` itself is unconstrained TEXT,
 * so an agent hand-written into the table could still carry the sentinel —
 * this refuses to write for one, so the collision is enforced rather than
 * argued away (schema.sql, Idempotency).
 */
const HUMAN_WRITER = ':human';

function writerOf(sender: { readonly kind: 'agent' | 'human'; readonly id?: AgentId }): string {
  if (sender.kind !== 'agent' || sender.id === undefined) return HUMAN_WRITER;
  if (sender.id === HUMAN_WRITER) {
    throw invalid(`an agent may not use the reserved writer id ${HUMAN_WRITER}`);
  }
  return sender.id;
}

export function openStore(options: StoreOptions): Store {
  if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true });
  const db: Db = new Database(options.file);

  // Outside any transaction, and before the schema exists: foreign keys are
  // per-connection, and WAL is a property of the file.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  const clock = options.now ?? (() => new Date());
  const now = (): Timestamp => clock().toISOString() as Timestamp;
  const humanDisplayName = options.humanDisplayName;

  const schema = migrate(db, undefined, now);

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  const st = {
    nextSeq: db.prepare<[], { next: number }>(
      "UPDATE sequence SET next = next + 1 WHERE name = 'stream' RETURNING next",
    ),
    tip: db.prepare<[], { next: number }>("SELECT next FROM sequence WHERE name = 'stream'"),

    insertAgent: db.prepare<{ id: string; name: string; at: string }, unknown>(
      'INSERT INTO agent (id, display_name, created_at) VALUES (@id, @name, @at)',
    ),
    getAgent: db.prepare<{ id: string }, AgentRow>('SELECT * FROM agent WHERE id = @id'),
    getAgentByName: db.prepare<{ name: string }, AgentRow>(
      'SELECT * FROM agent WHERE display_name = @name',
    ),
    renameAgent: db.prepare<{ id: string; name: string }, unknown>(
      'UPDATE agent SET display_name = @name WHERE id = @id',
    ),
    insertLabelHistory: db.prepare<
      { kind: string; subject: string; label: string; until: string },
      unknown
    >(
      'INSERT INTO label_history (kind, subject_id, label, until) ' +
        'VALUES (@kind, @subject, @label, @until)',
    ),
    // The label in force at @at: the earliest row that outlived it. None
    // means the current label was already in force.
    labelAsOf: db.prepare<{ kind: string; subject: string; at: string }, { label: string }>(
      'SELECT label FROM label_history WHERE kind = @kind AND subject_id = @subject ' +
        'AND until > @at ORDER BY until ASC, seq ASC LIMIT 1',
    ),
    setArchived: db.prepare<{ id: string; archived: number }, unknown>(
      'UPDATE agent SET archived = @archived WHERE id = @id',
    ),
    listAgents: db.prepare<{ includeArchived: number }, AgentRow>(
      'SELECT * FROM agent WHERE (@includeArchived = 1 OR archived = 0) ORDER BY display_name',
    ),
    touchAgent: db.prepare<{ id: string; at: string }, unknown>(
      'UPDATE agent SET last_seen_at = @at WHERE id = @id',
    ),
    countFailedAuth: db.prepare<{ id: string }, unknown>(
      'UPDATE agent SET failed_auth_attempts = failed_auth_attempts + 1 WHERE id = @id',
    ),

    insertKey: db.prepare<
      { id: string; agent: string; hash: string; label: string | null; at: string },
      unknown
    >(
      'INSERT INTO api_key (id, agent_id, key_hash, label, created_at) ' +
        'VALUES (@id, @agent, @hash, @label, @at)',
    ),
    keyByHash: db.prepare<
      { hash: string },
      { id: string; agent_id: string; key_hash: string; revoked_at: string | null }
    >('SELECT id, agent_id, key_hash, revoked_at FROM api_key WHERE key_hash = @hash'),
    revokeKey: db.prepare<{ id: string; at: string }, unknown>(
      'UPDATE api_key SET revoked_at = @at WHERE id = @id AND revoked_at IS NULL',
    ),
    revokeAgentKeys: db.prepare<{ agent: string; at: string }, unknown>(
      'UPDATE api_key SET revoked_at = @at WHERE agent_id = @agent AND revoked_at IS NULL',
    ),
    listKeys: db.prepare<
      { agent: string },
      {
        id: string;
        agent_id: string;
        label: string | null;
        created_at: string;
        revoked_at: string | null;
      }
    >(
      'SELECT id, agent_id, label, created_at, revoked_at FROM api_key ' +
        'WHERE agent_id = @agent ORDER BY created_at, id',
    ),

    insertSpace: db.prepare<{ id: string; name: string; at: string }, unknown>(
      'INSERT INTO space (id, name, created_at) VALUES (@id, @name, @at)',
    ),
    getSpace: db.prepare<{ id: string }, SpaceRow>('SELECT id, name FROM space WHERE id = @id'),
    renameSpace: db.prepare<{ id: string; name: string }, unknown>(
      'UPDATE space SET name = @name WHERE id = @id',
    ),
    listSpaces: db.prepare<[], SpaceRow>('SELECT id, name FROM space ORDER BY name'),

    openMembership: db.prepare<{ agent: string; space: string }, { id: string }>(
      'SELECT id FROM membership WHERE agent_id = @agent AND space_id = @space AND revoked_seq IS NULL',
    ),
    insertMembership: db.prepare<
      { id: string; agent: string; space: string; at: string; seq: number },
      unknown
    >(
      'INSERT INTO membership (id, agent_id, space_id, granted_at, granted_seq) ' +
        'VALUES (@id, @agent, @space, @at, @seq)',
    ),
    closeMembership: db.prepare<{ id: string; at: string; seq: number }, unknown>(
      'UPDATE membership SET revoked_at = @at, revoked_seq = @seq WHERE id = @id',
    ),
    everMember: db.prepare<{ agent: string; space: string }, { one: number }>(
      'SELECT 1 AS one FROM membership WHERE agent_id = @agent AND space_id = @space LIMIT 1',
    ),
    spacesForAgent: db.prepare<{ agent: string }, SpaceRow>(
      'SELECT s.id, s.name FROM space s JOIN membership m ON m.space_id = s.id ' +
        'WHERE m.agent_id = @agent AND m.revoked_seq IS NULL ORDER BY s.name',
    ),
    membershipIntervals: db.prepare<
      { agent: string | null; space: string | null },
      {
        id: string;
        agent_id: string;
        space_id: string;
        granted_at: string;
        revoked_at: string | null;
      }
    >(
      'SELECT id, agent_id, space_id, granted_at, revoked_at FROM membership ' +
        'WHERE (@agent IS NULL OR agent_id = @agent) AND (@space IS NULL OR space_id = @space) ' +
        'ORDER BY granted_seq',
    ),
    // Includes the caller: a roster that omits you is not a roster.
    peers: db.prepare<{ agent: string; space: string | null }, AgentNameRow>(
      'SELECT DISTINCT a.id, a.display_name FROM agent a ' +
        'JOIN membership m ON m.agent_id = a.id AND m.revoked_seq IS NULL ' +
        'WHERE a.archived = 0 AND m.space_id IN (' +
        '  SELECT space_id FROM membership WHERE agent_id = @agent AND revoked_seq IS NULL' +
        '    AND (@space IS NULL OR space_id = @space)' +
        ') ORDER BY a.display_name',
    ),
    resolveMentionName: db.prepare<{ space: string; name: string }, { id: string }>(
      'SELECT a.id FROM agent a JOIN membership m ON m.agent_id = a.id AND m.revoked_seq IS NULL ' +
        'WHERE m.space_id = @space AND a.display_name = @name AND a.archived = 0',
    ),
    // Ever a member, not currently: a message that named someone keeps naming
    // them after they leave. Scoping to the space at all is what stops a
    // hand-written token probing for a stranger's name.
    resolveMentionRef: db.prepare<{ space: string; agent: string }, { display_name: string }>(
      'SELECT a.display_name FROM agent a WHERE a.id = @agent AND EXISTS (' +
        '  SELECT 1 FROM membership m WHERE m.agent_id = a.id AND m.space_id = @space)',
    ),

    insertConversation: db.prepare<
      { id: string; space: string; title: string; at: string; by: string | null },
      unknown
    >(
      'INSERT INTO conversation (id, space_id, title, created_at, created_by_agent_id) ' +
        'VALUES (@id, @space, @title, @at, @by) ON CONFLICT (space_id, title) DO NOTHING',
    ),
    conversationByTitle: db.prepare<{ space: string; title: string }, ConversationRow>(
      'SELECT id, space_id, title FROM conversation WHERE space_id = @space AND title = @title',
    ),
    getConversation: db.prepare<{ id: string }, ConversationRow>(
      'SELECT id, space_id, title FROM conversation WHERE id = @id',
    ),
    renameConversation: db.prepare<{ id: string; title: string }, unknown>(
      'UPDATE conversation SET title = @title WHERE id = @id',
    ),
    insertMessage: db.prepare<
      {
        seq: number;
        id: string;
        conversation: string;
        space: string;
        senderKind: string;
        senderAgent: string | null;
        body: string;
        at: string;
      },
      unknown
    >(
      'INSERT INTO message (seq, id, conversation_id, space_id, sender_kind, sender_agent_id, body, sent_at) ' +
        'VALUES (@seq, @id, @conversation, @space, @senderKind, @senderAgent, @body, @at)',
    ),
    messageBySeq: db.prepare<{ seq: number }, MessageRow>('SELECT * FROM message WHERE seq = @seq'),
    messageById: db.prepare<{ id: string }, MessageRow>('SELECT * FROM message WHERE id = @id'),
    insertAttachment: db.prepare<
      {
        id: string;
        message: string;
        filename: string;
        contentType: string;
        size: number;
        at: string;
      },
      unknown
    >(
      'INSERT INTO attachment (id, message_id, filename, content_type, size_bytes, created_at) ' +
        'VALUES (@id, @message, @filename, @contentType, @size, @at)',
    ),
    attachmentsFor: db.prepare<{ message: string }, AttachmentRow>(
      'SELECT id, filename, content_type, size_bytes FROM attachment ' +
        'WHERE message_id = @message ORDER BY created_at, id',
    ),
    getAttachment: db.prepare<
      { id: string },
      AttachmentRow & { message_id: string; space_id: string }
    >(
      'SELECT a.id, a.filename, a.content_type, a.size_bytes, a.message_id, m.space_id ' +
        'FROM attachment a JOIN message m ON m.id = a.message_id WHERE a.id = @id',
    ),

    insertEvent: db.prepare<
      { seq: number; id: string; agent: string; kind: string; space: string; at: string },
      unknown
    >(
      'INSERT INTO system_event (seq, id, agent_id, kind, space_id, created_at) ' +
        'VALUES (@seq, @id, @agent, @kind, @space, @at)',
    ),
    eventBySeq: db.prepare<{ seq: number }, EventRow>(
      'SELECT * FROM system_event WHERE seq = @seq',
    ),

    // The whole access rule, in one place.
    //
    // A message is delivered when the agent can see its space *now* AND the
    // message fell inside one of that agent's membership intervals when it was
    // written. Both are needed: the first hides a revoked space's backlog, the
    // second stops a new grant replaying history (ADR-0009).
    //
    // System events carry no access test at all — a revocation must deliver
    // the event announcing it.
    streamPage: db.prepare<{ agent: string; after: number; tip: number; limit: number }, StreamRow>(
      'SELECT seq, kind FROM (' +
        "  SELECT m.seq AS seq, 'message' AS kind FROM message m" +
        '   WHERE m.seq > @after AND m.seq <= @tip' +
        '     AND EXISTS (SELECT 1 FROM membership cur WHERE cur.agent_id = @agent' +
        '                   AND cur.space_id = m.space_id AND cur.revoked_seq IS NULL)' +
        '     AND EXISTS (SELECT 1 FROM membership win WHERE win.agent_id = @agent' +
        '                   AND win.space_id = m.space_id AND m.seq > win.granted_seq' +
        '                   AND (win.revoked_seq IS NULL OR m.seq < win.revoked_seq))' +
        '  UNION ALL' +
        "  SELECT e.seq AS seq, 'event' AS kind FROM system_event e" +
        '   WHERE e.seq > @after AND e.seq <= @tip AND e.agent_id = @agent' +
        ') ORDER BY seq LIMIT @limit',
    ),
    streamAnchorBefore: db.prepare<{ since: string }, { seq: number | null }>(
      'SELECT MAX(seq) AS seq FROM (' +
        '  SELECT seq FROM message WHERE sent_at < @since' +
        '  UNION ALL' +
        '  SELECT seq FROM system_event WHERE created_at < @since' +
        ')',
    ),

    // Two statements per source rather than one with a conditional ORDER BY:
    // the direction has to be visible to the query planner, or the index on
    // (conversation_id, seq) stops being an ordering and becomes a sort.
    // `@after` is the exclusive bound in the direction of travel — a floor
    // going forwards, a ceiling going backwards.
    conversationPage: db.prepare<
      {
        conversation: string;
        after: number;
        since: string | null;
        until: string | null;
        limit: number;
      },
      MessageRow
    >(
      'SELECT * FROM message WHERE conversation_id = @conversation AND seq > @after ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq LIMIT @limit',
    ),
    conversationPageBackwards: db.prepare<
      {
        conversation: string;
        after: number;
        since: string | null;
        until: string | null;
        limit: number;
      },
      MessageRow
    >(
      'SELECT * FROM message WHERE conversation_id = @conversation AND seq < @after ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq DESC LIMIT @limit',
    ),
    spacePage: db.prepare<
      { space: string; after: number; since: string | null; until: string | null; limit: number },
      MessageRow
    >(
      'SELECT * FROM message WHERE space_id = @space AND seq > @after ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq LIMIT @limit',
    ),
    spacePageBackwards: db.prepare<
      { space: string; after: number; since: string | null; until: string | null; limit: number },
      MessageRow
    >(
      'SELECT * FROM message WHERE space_id = @space AND seq < @after ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq DESC LIMIT @limit',
    ),

    // One grouped query for the whole thread list.
    //
    // The bare columns beside MAX(m.seq) are the values from the row that
    // produced the maximum — SQLite defines that for a query with exactly one
    // min/max aggregate, and it is why this needs no correlated subquery per
    // conversation. LEFT JOIN, so a thread nobody has posted to still appears.
    //
    // Ordered by last activity, which is what a thread list is for; NULL sorts
    // last under DESC, so empty threads fall to the bottom.
    conversationSummaries: db.prepare<{ space: string }, ConversationSummaryRow>(
      'SELECT c.id AS id, c.space_id AS space_id, c.title AS title, ' +
        '       COUNT(m.seq) AS message_count, MAX(m.seq) AS last_seq, ' +
        '       m.sent_at AS last_sent_at, m.sender_kind AS last_sender_kind, ' +
        '       m.sender_agent_id AS last_sender_agent_id, a.display_name AS last_sender_name ' +
        '  FROM conversation c ' +
        '  LEFT JOIN message m ON m.conversation_id = c.id ' +
        '  LEFT JOIN agent a ON a.id = m.sender_agent_id ' +
        ' WHERE c.space_id = @space ' +
        ' GROUP BY c.id ' +
        ' ORDER BY last_seq DESC, c.created_at DESC, c.id',
    ),
    search: db.prepare<
      { query: string; space: string | null; limit: number },
      MessageRow & { snippet: string }
    >(
      `SELECT m.*, snippet(message_fts, 0, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 24) AS snippet ` +
        'FROM message_fts JOIN message m ON m.seq = message_fts.rowid ' +
        'WHERE message_fts MATCH @query AND (@space IS NULL OR m.space_id = @space) ' +
        'ORDER BY rank LIMIT @limit',
    ),

    getIdempotency: db.prepare<
      { writer: string; key: string },
      { request_hash: string; outcome_json: string }
    >('SELECT request_hash, outcome_json FROM idempotency WHERE writer = @writer AND key = @key'),
    putIdempotency: db.prepare<
      { writer: string; key: string; hash: string; outcome: string; at: string },
      unknown
    >(
      'INSERT INTO idempotency (writer, key, request_hash, outcome_json, created_at) ' +
        'VALUES (@writer, @key, @hash, @outcome, @at)',
    ),

    insertRead: db.prepare<
      {
        id: string;
        agent: string;
        at: string;
        kind: string;
        params: string;
        cursor: string;
        count: number;
      },
      unknown
    >(
      'INSERT INTO read_log (id, agent_id, read_at, kind, params_json, cursor, item_count) ' +
        'VALUES (@id, @agent, @at, @kind, @params, @cursor, @count)',
    ),
    // Keyset paging, not OFFSET: the log only grows, and a page taken by
    // offset while it grows either repeats rows or skips them — in the one
    // view whose whole job is completeness.
    //
    // Two statements rather than one with `@agent IS NULL OR agent_id =
    // @agent`, because a plan is chosen when a statement is prepared and not
    // when it is bound: that disjunction cannot use the composite index, so
    // asking for one agent's reads would walk the whole log filtering as it
    // went. Named separately, each gets the index that answers it.
    listReads: db.prepare<ReadLogBounds, ReadLogRow>(READ_LOG_COLUMNS + '1 = 1' + READ_LOG_TAIL),
    listReadsForAgent: db.prepare<ReadLogBounds & { agent: string }, ReadLogRow>(
      READ_LOG_COLUMNS + 'agent_id = @agent' + READ_LOG_TAIL,
    ),
    lastStreamRead: db.prepare<{ agent: string }, { cursor: string }>(
      "SELECT cursor FROM read_log WHERE agent_id = @agent AND kind = 'stream' " +
        'ORDER BY read_at DESC, rowid DESC LIMIT 1',
    ),

    insertEscalation: db.prepare<
      { id: string; agent: string; conversation: string; reason: string; at: string },
      unknown
    >(
      'INSERT INTO escalation (id, agent_id, conversation_id, reason, created_at, notification_state) ' +
        "VALUES (@id, @agent, @conversation, @reason, @at, 'pending')",
    ),
    getEscalation: db.prepare<{ id: string }, EscalationRow>(
      'SELECT * FROM escalation WHERE id = @id',
    ),
    listEscalations: db.prepare<
      { state: string | null; dueAt: string | null; limit: number },
      EscalationRow
    >(
      'SELECT * FROM escalation WHERE (@state IS NULL OR notification_state = @state) ' +
        'AND (@dueAt IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= @dueAt) ' +
        'ORDER BY created_at, id LIMIT @limit',
    ),
    markEscalation: db.prepare<
      {
        id: string;
        state: string;
        at: string;
        error: string | null;
        next: string | null;
      },
      unknown
    >(
      'UPDATE escalation SET notification_state = @state, attempts = attempts + 1, ' +
        'last_attempt_at = @at, last_error = @error, next_attempt_at = @next WHERE id = @id',
    ),

    insertSession: db.prepare<{ id: string; hash: string; at: string; expires: string }, unknown>(
      'INSERT INTO session (id, token_hash, created_at, expires_at) ' +
        'VALUES (@id, @hash, @at, @expires)',
    ),
    sessionByHash: db.prepare<
      { hash: string },
      { id: string; created_at: string; expires_at: string }
    >('SELECT id, created_at, expires_at FROM session WHERE token_hash = @hash'),
    deleteSession: db.prepare<{ hash: string }, unknown>(
      'DELETE FROM session WHERE token_hash = @hash',
    ),
    deleteExpiredSessions: db.prepare<{ at: string }, unknown>(
      'DELETE FROM session WHERE expires_at <= @at',
    ),
  };

  // -------------------------------------------------------------------------
  // Small helpers over the statements
  // -------------------------------------------------------------------------

  function nextSeq(): number {
    const row = st.nextSeq.get();
    /* c8 ignore next */
    if (row === undefined) throw new Error('stream sequence row is missing');
    return row.next;
  }

  function tip(): number {
    return st.tip.get()?.next ?? 0;
  }

  function toAgentRecord(row: AgentRow): AgentRecord {
    return {
      id: row.id as AgentId,
      displayName: row.display_name,
      archived: row.archived === 1,
      createdAt: row.created_at as Timestamp,
      lastSeenAt: row.last_seen_at as Timestamp | null,
      failedAuthAttempts: row.failed_auth_attempts,
    };
  }

  function toSpace(row: SpaceRow): Space {
    return { id: row.id as SpaceId, name: row.name };
  }

  function toConversation(row: ConversationRow): Conversation {
    return {
      id: row.id as ConversationId,
      space: row.space_id as SpaceId,
      title: row.title,
    };
  }

  function toEscalation(row: EscalationRow): EscalationRecord {
    return {
      id: row.id,
      agent: row.agent_id as AgentId,
      conversation: row.conversation_id as ConversationId,
      reason: row.reason,
      createdAt: row.created_at as Timestamp,
      notificationState: row.notification_state as NotificationState,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at as Timestamp | null,
      nextAttemptAt: row.next_attempt_at as Timestamp | null,
      lastError: row.last_error,
    };
  }

  function toReadLogEntry(row: ReadLogRow): ReadLogEntry {
    return {
      id: row.id,
      agent: row.agent_id as AgentId,
      readAt: row.read_at as Timestamp,
      kind: row.kind as ReadKind,
      params: JSON.parse(row.params_json) as unknown,
      cursor: row.cursor,
      itemCount: row.item_count,
    };
  }

  /** The sender of a conversation's last message, or null if it has none. */
  function toLastSender(row: ConversationSummaryRow): Sender | null {
    if (row.last_sender_kind === null) return null;
    if (row.last_sender_agent_id === null) {
      // No user record: the human's name is configuration, like everywhere.
      return { kind: 'human', displayName: humanDisplayName };
    }
    /* c8 ignore next */
    if (row.last_sender_name === null) throw new Error('message references a missing agent');
    return {
      kind: 'agent',
      id: row.last_sender_agent_id as AgentId,
      displayName: row.last_sender_name,
    };
  }

  function requireAgentRow(agent: AgentId): AgentRow {
    const row = st.getAgent.get({ id: agent });
    if (row === undefined) throw notFound('agent');
    return row;
  }

  function requireSpaceRow(space: SpaceId): SpaceRow {
    const row = st.getSpace.get({ id: space });
    if (row === undefined) throw notFound('space');
    return row;
  }

  function isCurrentMember(agent: AgentId, space: SpaceId): boolean {
    return st.openMembership.get({ agent, space }) !== undefined;
  }

  /**
   * Current access, evaluated at read time. Everything an agent may not see
   * reports `not_found`, so error codes cannot map the fleet (ADR-0003).
   */
  function requireReadAccess(reader: Reader, space: SpaceId, what: string): void {
    if (reader.kind === 'human') return;
    if (!isCurrentMember(reader.id, space)) throw notFound(what);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * A per-call cache: one page can hold many messages from one conversation
   * written by one sender, and each of those is a label lookup.
   */
  interface RenderCache {
    titles: Map<string, string>;
    names: Map<string, string>;
    mentionNames: Map<string, string | undefined>;
    /** Render labels as they were at this instant; absent means now. */
    asOf: Timestamp | undefined;
  }

  function newRenderCache(asOf?: Timestamp): RenderCache {
    return { titles: new Map(), names: new Map(), mentionNames: new Map(), asOf };
  }

  /** `current` unless a rename since `cache.asOf` says the label was different then. */
  function labelAsOf(cache: RenderCache, kind: string, subject: string, current: string): string {
    if (cache.asOf === undefined) return current;
    return st.labelAsOf.get({ kind, subject, at: cache.asOf })?.label ?? current;
  }

  function conversationTitle(cache: RenderCache, id: string): string {
    const cached = cache.titles.get(id);
    if (cached !== undefined) return cached;
    const row = st.getConversation.get({ id });
    /* c8 ignore next */
    if (row === undefined) throw new Error(`message references a missing conversation ${id}`);
    const title = labelAsOf(cache, 'conversation', id, row.title);
    cache.titles.set(id, title);
    return title;
  }

  function agentName(cache: RenderCache, id: string): string {
    const cached = cache.names.get(id);
    if (cached !== undefined) return cached;
    const row = st.getAgent.get({ id });
    /* c8 ignore next */
    if (row === undefined) throw new Error(`message references a missing agent ${id}`);
    const name = labelAsOf(cache, 'agent', id, row.display_name);
    cache.names.set(id, name);
    return name;
  }

  function mentionName(cache: RenderCache, space: string, agent: AgentId): string | undefined {
    const key = `${space}:${agent}`;
    if (cache.mentionNames.has(key)) return cache.mentionNames.get(key);
    const row = st.resolveMentionRef.get({ space, agent });
    const name = row === undefined ? undefined : labelAsOf(cache, 'agent', agent, row.display_name);
    cache.mentionNames.set(key, name);
    return name;
  }

  function toMessage(row: MessageRow, cache: RenderCache): Message {
    const resolve = (agent: AgentId): string | undefined => mentionName(cache, row.space_id, agent);
    const sender: Sender =
      row.sender_agent_id === null
        ? { kind: 'human', displayName: humanDisplayName }
        : {
            kind: 'agent',
            id: row.sender_agent_id as AgentId,
            displayName: agentName(cache, row.sender_agent_id),
          };
    return {
      kind: 'message',
      id: row.id as MessageId,
      space: row.space_id as SpaceId,
      conversation: row.conversation_id as ConversationId,
      conversationTitle: conversationTitle(cache, row.conversation_id),
      sender,
      body: renderMentions(row.body, resolve),
      mentions: parseMentions(row.body, (agent) => resolve(agent) !== undefined),
      attachments: toAttachments(row.id),
      sentAt: row.sent_at as Timestamp,
    };
  }

  function toAttachments(messageId: string): readonly Attachment[] {
    return st.attachmentsFor.all({ message: messageId }).map((a) => ({
      id: a.id as AttachmentId,
      filename: a.filename,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
    }));
  }

  function toEvent(row: EventRow): SystemEvent {
    if (row.kind === 'space_access_granted') {
      // The space itself, not just its id: an agent just introduced to one
      // should not need another call to learn what it is called.
      const space = st.getSpace.get({ id: row.space_id });
      /* c8 ignore next */
      if (space === undefined) throw new Error(`event references a missing space ${row.space_id}`);
      return {
        kind: 'space_access_granted',
        id: row.id as EventId,
        space: toSpace(space),
        at: row.created_at as Timestamp,
      };
    }
    return {
      kind: 'space_access_revoked',
      id: row.id as EventId,
      space: row.space_id as SpaceId,
      at: row.created_at as Timestamp,
    };
  }

  // -------------------------------------------------------------------------
  // Mentions
  // -------------------------------------------------------------------------

  function canonicalBody(space: SpaceId, body: string): string {
    return encodeMentions(body, (name) => {
      const row = st.resolveMentionName.get({ space, name });
      return row === undefined ? undefined : (row.id as AgentId);
    });
  }

  // -------------------------------------------------------------------------
  // Read-log recording
  // -------------------------------------------------------------------------

  function writeRead(
    agent: AgentId,
    kind: ReadKind,
    params: unknown,
    cursor: string,
    itemCount: number,
  ): void {
    st.insertRead.run({
      id: newId(),
      agent,
      at: now(),
      kind,
      params: JSON.stringify(params ?? null),
      cursor,
      count: itemCount,
    });
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  const grantTx = db.transaction((agent: AgentId, space: SpaceId): boolean => {
    requireAgentRow(agent);
    requireSpaceRow(space);
    // Already current is a no-op, not a second open interval (ADR-0011). No
    // event either: nothing changed, and an event says something did.
    if (isCurrentMember(agent, space)) return false;
    const seq = nextSeq();
    const at = now();
    st.insertEvent.run({
      seq,
      id: newId(),
      agent,
      kind: 'space_access_granted',
      space,
      at,
    });
    // granted_seq is the event's seq, so the interval opens exactly where the
    // announcement lands and nothing written before it is delivered.
    st.insertMembership.run({ id: newId(), agent, space, at, seq });
    return true;
  });

  const revokeTx = db.transaction((agent: AgentId, space: SpaceId): boolean => {
    requireAgentRow(agent);
    requireSpaceRow(space);
    const open = st.openMembership.get({ agent, space });
    if (open === undefined) return false;
    const seq = nextSeq();
    const at = now();
    st.insertEvent.run({ seq, id: newId(), agent, kind: 'space_access_revoked', space, at });
    // The interval is closed, never cleared: the row stays as history.
    st.closeMembership.run({ id: open.id, at, seq });
    return true;
  });

  const resolveConversationTx = db.transaction(
    (space: SpaceId, title: string, createdBy: Writer | undefined): ConversationRow => {
      // Resolve-or-create in one statement pair inside one transaction, so two
      // writers racing on the same subject line cannot open two threads
      // (ADR-0012).
      st.insertConversation.run({
        id: newId(),
        space,
        title,
        at: now(),
        by: createdBy !== undefined && createdBy.kind === 'agent' ? createdBy.id : null,
      });
      const row = st.conversationByTitle.get({ space, title });
      /* c8 ignore next */
      if (row === undefined) throw new Error('conversation vanished after insert');
      return row;
    },
  );

  interface PostOutcome {
    readonly messageId: string;
  }

  function renderPost(messageId: string, created: boolean): PostMessageResult {
    const cache = newRenderCache();
    const row = st.messageById.get({ id: messageId });
    /* c8 ignore next */
    if (row === undefined) throw new Error(`message ${messageId} vanished`);
    const conversation = st.getConversation.get({ id: row.conversation_id });
    /* c8 ignore next */
    if (conversation === undefined) throw new Error('conversation vanished');
    return {
      message: toMessage(row, cache),
      conversation: toConversation(conversation),
      created,
    };
  }

  const postTx = db.transaction((input: PostMessageInput): PostMessageResult => {
    const { sender } = input;

    // Validate before anything else, including before the idempotency lookup:
    // a rejected write should be rejected identically whether or not its key
    // has been seen, and the reserved sequence must never reach a stored row
    // from input — the only one a row carries is the encoder's own mention
    // marker (text.ts), which is what makes that marker unforgeable.
    assertNoReservedSequence('body', input.body);
    if ('title' in input.target) assertNonEmpty('title', input.target.title);
    for (const attachment of input.attachments ?? []) {
      assertNoReservedSequence('filename', attachment.filename);
      assertNoReservedSequence('contentType', attachment.contentType);
    }
    if (input.body.trim().length === 0 && (input.attachments ?? []).length === 0) {
      throw invalid('body must not be empty unless the message carries an attachment');
    }

    const hash = requestHash({
      op: 'post',
      target:
        'conversation' in input.target
          ? { conversation: input.target.conversation }
          : { space: input.target.space, title: input.target.title },
      body: input.body,
      // Deliberately without `id`: attachment ids are minted per request, so a
      // retry that uploads the same files carries different ones and would
      // hash differently every time — the write would never be replayable,
      // which is the one thing the key promises. What identifies a file here
      // is what the caller stated about it, plus `contentDigest` when the
      // caller computed one.
      attachments: (input.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        contentDigest: a.contentDigest ?? null,
      })),
    });

    if (input.idempotencyKey !== undefined) {
      const existing = st.getIdempotency.get({
        writer: writerOf(sender),
        key: input.idempotencyKey,
      });
      if (existing !== undefined) {
        // One namespace serves posts and escalations, and their outcomes
        // differ in shape. A key last used for the other operation is a
        // different request under the same key — the answer the hash check
        // below would give, reached before the outcome is trusted enough to
        // dereference.
        const outcome = JSON.parse(existing.outcome_json) as Partial<PostOutcome>;
        if (typeof outcome.messageId !== 'string') {
          throw invalid('idempotency key was already used for a different request');
        }
        const replayed = st.messageById.get({ id: outcome.messageId });
        /* c8 ignore next */
        if (replayed === undefined) throw new Error(`message ${outcome.messageId} vanished`);

        // A replay hands back a rendered message, so it is a read as well as a
        // write and follows current access like every other read. Otherwise an
        // agent removed from a space could recover its contents by replaying
        // keys it minted itself.
        //
        // Checked before the hash, so losing access looks the same whether the
        // replayed request matches or not — and the same as a space that never
        // existed (ADR-0003).
        if (sender.kind === 'agent' && !isCurrentMember(sender.id, replayed.space_id as SpaceId)) {
          throw notFound('conversation' in input.target ? 'conversation' : 'space');
        }

        // A different request under the same key is an error, not a silent
        // replay of the old answer.
        if (!constantTimeEquals(existing.request_hash, hash)) {
          throw invalid('idempotency key was already used for a different request');
        }
        return renderPost(outcome.messageId, false);
      }
    }

    // Resolve the target, then check access against the resolved space.
    let conversationRow: ConversationRow;
    if ('conversation' in input.target) {
      const found = st.getConversation.get({ id: input.target.conversation });
      if (found === undefined) throw notFound('conversation');
      if (sender.kind === 'agent' && !isCurrentMember(sender.id, found.space_id as SpaceId)) {
        throw notFound('conversation');
      }
      conversationRow = found;
    } else {
      const space = input.target.space;
      if (st.getSpace.get({ id: space }) === undefined) throw notFound('space');
      if (sender.kind === 'agent' && !isCurrentMember(sender.id, space)) throw notFound('space');
      conversationRow = resolveConversationTx(space, input.target.title, sender);
    }

    const space = conversationRow.space_id as SpaceId;
    const seq = nextSeq();
    const id = newId();
    const at = now();
    st.insertMessage.run({
      seq,
      id,
      conversation: conversationRow.id,
      space,
      senderKind: sender.kind,
      senderAgent: sender.kind === 'agent' ? sender.id : null,
      body: canonicalBody(space, input.body),
      at,
    });
    for (const attachment of input.attachments ?? []) {
      st.insertAttachment.run({
        id: attachment.id,
        message: id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.sizeBytes,
        at,
      });
    }

    // Same transaction as the write itself: a key never exists without its
    // outcome, nor an outcome without its key.
    if (input.idempotencyKey !== undefined) {
      const outcome: PostOutcome = { messageId: id };
      st.putIdempotency.run({
        writer: writerOf(sender),
        key: input.idempotencyKey,
        hash,
        outcome: JSON.stringify(outcome),
        at,
      });
    }

    return renderPost(id, true);
  });

  interface EscalationOutcomeRecord {
    readonly escalationId: string;
  }

  const escalateTx = db.transaction((input: RecordEscalationInput): EscalationOutcome => {
    assertNonEmpty('reason', input.reason);

    const hash = requestHash({
      op: 'escalate',
      conversation: input.conversation,
      reason: input.reason,
    });

    const existing = st.getIdempotency.get({ writer: input.agent, key: input.idempotencyKey });
    if (existing !== undefined) {
      // As in `postTx`: a key last used for a post is a different request.
      const outcome = JSON.parse(existing.outcome_json) as Partial<EscalationOutcomeRecord>;
      if (typeof outcome.escalationId !== 'string') {
        throw invalid('idempotency key was already used for a different request');
      }
      const row = st.getEscalation.get({ id: outcome.escalationId });
      /* c8 ignore next */
      if (row === undefined) throw new Error('escalation vanished');
      // Same rule as a replayed post: a replay is a read, and reads follow
      // current access. Less to leak here — the reason is the agent's own
      // words — but confirming an escalation about a space it can no longer
      // see is still an answer it is not entitled to.
      const raisedIn = st.getConversation.get({ id: row.conversation_id });
      /* c8 ignore next */
      if (raisedIn === undefined) throw new Error('escalation references a missing conversation');
      if (!isCurrentMember(input.agent, raisedIn.space_id as SpaceId))
        throw notFound('conversation');
      if (!constantTimeEquals(existing.request_hash, hash)) {
        throw invalid('idempotency key was already used for a different request');
      }
      return { escalation: toEscalation(row), created: false };
    }

    const conversation = st.getConversation.get({ id: input.conversation });
    if (conversation === undefined) throw notFound('conversation');
    if (!isCurrentMember(input.agent, conversation.space_id as SpaceId)) {
      throw notFound('conversation');
    }

    const id = newId();
    const at = now();
    st.insertEscalation.run({
      id,
      agent: input.agent,
      conversation: input.conversation,
      reason: input.reason,
      at,
    });
    const outcome: EscalationOutcomeRecord = { escalationId: id };
    st.putIdempotency.run({
      writer: input.agent,
      key: input.idempotencyKey,
      hash,
      outcome: JSON.stringify(outcome),
      at,
    });
    const row = st.getEscalation.get({ id });
    /* c8 ignore next */
    if (row === undefined) throw new Error('escalation vanished');
    return { escalation: toEscalation(row), created: true };
  });

  /**
   * A rename journals the label it replaces, in the same transaction, so the
   * label in force at any past instant stays answerable (migration 0002).
   * Renaming to the same label is a no-op: nothing changed, so no history.
   */
  const renameAgentTx = db.transaction((agent: AgentId, displayName: string): AgentRecord => {
    const before = requireAgentRow(agent);
    if (before.display_name !== displayName) {
      try {
        st.renameAgent.run({ id: agent, name: displayName });
      } catch (error) {
        throw uniqueOr(error, 'an agent with that name already exists');
      }
      st.insertLabelHistory.run({
        kind: 'agent',
        subject: agent,
        label: before.display_name,
        until: now(),
      });
    }
    return toAgentRecord(requireAgentRow(agent));
  });

  const renameConversationTx = db.transaction(
    (conversation: ConversationId, title: string): Conversation => {
      const before = st.getConversation.get({ id: conversation });
      if (before === undefined) throw notFound('conversation');
      if (before.title !== title) {
        try {
          st.renameConversation.run({ id: conversation, title });
        } catch (error) {
          throw uniqueOr(error, 'a conversation with that title already exists in this space');
        }
        st.insertLabelHistory.run({
          kind: 'conversation',
          subject: conversation,
          label: before.title,
          until: now(),
        });
      }
      const renamed = st.getConversation.get({ id: conversation });
      /* c8 ignore next */
      if (renamed === undefined) throw new Error('conversation vanished');
      return toConversation(renamed);
    },
  );

  const archiveTx = db.transaction((agent: AgentId): AgentRecord => {
    requireAgentRow(agent);
    // Archiving revokes credentials and hides the role. It does not touch
    // membership, which is history (ADR-0013).
    st.revokeAgentKeys.run({ agent, at: now() });
    st.setArchived.run({ id: agent, archived: 1 });
    return toAgentRecord(requireAgentRow(agent));
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  function anchorFor(from: ReadFrom | undefined, currentTip: number): number {
    if (from === undefined) return 0;
    if ('after' in from) return decodeCursor(from.after);
    if ('from' in from) return currentTip;
    // Anchored strictly before `since`, so an item at exactly that instant is
    // included: `since` is inclusive.
    const at = normalizeTimestamp('since', from.since);
    return st.streamAnchorBefore.get({ since: at })?.seq ?? 0;
  }

  const readStreamTx = db.transaction((agent: AgentId, args: ReadStreamArgs): StreamPage => {
    requireAgentRow(agent);
    const limit = clampLimit(args.limit);
    // Read the tip first and bound the query by it, so "everything up to here
    // was considered" is true of exactly the rows the query could have seen.
    const currentTip = tip();
    const after = anchorFor(args.from, currentTip);

    const rows = st.streamPage.all({ agent, after, tip: currentTip, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const cache = newRenderCache();
    const items: StreamItem[] = page.map((row) => {
      if (row.kind === 'message') {
        const message = st.messageBySeq.get({ seq: row.seq });
        /* c8 ignore next */
        if (message === undefined) throw new Error(`message at seq ${row.seq} vanished`);
        return toMessage(message, cache);
      }
      const event = st.eventBySeq.get({ seq: row.seq });
      /* c8 ignore next */
      if (event === undefined) throw new Error(`event at seq ${row.seq} vanished`);
      return toEvent(event);
    });

    // Items that failed the filter are skipped and the cursor advances past
    // them: never stall, never re-deliver later. When the page is not full,
    // everything up to the tip has been considered, so the cursor is the tip
    // rather than the last item's seq — which is what makes the stream
    // deliberately non-reproducible (ADR-0009).
    const lastSeq = page.at(-1)?.seq;
    const nextSeqValue = hasMore && lastSeq !== undefined ? lastSeq : Math.max(currentTip, after);
    const nextCursor = encodeCursor(nextSeqValue);

    writeRead(agent, 'stream', { from: args.from ?? null, limit }, nextCursor, items.length);
    return { items, nextCursor, hasMore };
  });

  interface QueryPlan {
    readonly order: 'oldest' | 'newest';
    /**
     * The exclusive bound in the direction of travel: a floor for `oldest`, a
     * ceiling for `newest`. One number either way, so a cursor stays one
     * opaque token and the direction stays a property of the request.
     */
    readonly after: number;
    readonly since: string | null;
    readonly until: string | null;
    readonly limit: number;
  }

  /**
   * `order` picks which end to start from and which way to walk; `since` and
   * `until` bound the same set either way. So the two orders return the same
   * messages, in opposite orders, from opposite ends.
   *
   * A cursor is a position, not a direction: handing an `oldest` cursor to a
   * `newest` read means "everything older than here", which is exactly what
   * turning around at a known point should mean.
   */
  function planQuery(range: Range | undefined, limit: number | undefined): QueryPlan {
    const order = range?.order ?? 'oldest';
    // The HTTP layer validates this against `Range`, but the store is also
    // called directly, and a typo would otherwise silently read forwards.
    if (order !== 'oldest' && order !== 'newest') {
      throw invalid("order must be 'oldest' or 'newest'");
    }
    return {
      order,
      after:
        range?.after !== undefined
          ? decodeQueryCursor(range.after)
          : // Nothing seen yet. Forwards that is the floor below every seq;
            // backwards it is a ceiling above every seq, taken once here so
            // that messages written mid-page cannot shift the window.
            order === 'oldest'
            ? 0
            : tip() + 1,
      since: range?.since === undefined ? null : normalizeTimestamp('since', range.since),
      until: range?.until === undefined ? null : normalizeTimestamp('until', range.until),
      limit: clampLimit(limit),
    };
  }

  /**
   * A query, not a stream position. Nothing is skipped, so the cursor is the
   * last row returned and an empty page leaves the position where it was —
   * unlike the stream, whose cursor jumps past what the access filter removed.
   *
   * `rows` already arrive in the requested order, so this is the same
   * arithmetic in both directions: the page is what fits, `hasMore` is the
   * row that did not, and the cursor is the last row handed over — the oldest
   * one when reading backwards, which is where the next page continues from.
   */
  function pageMessages(rows: readonly MessageRow[], plan: QueryPlan): MessagePage {
    const hasMore = rows.length > plan.limit;
    const page = rows.slice(0, plan.limit);
    const cache = newRenderCache();
    const lastSeq = page.at(-1)?.seq ?? plan.after;
    return {
      messages: page.map((row) => toMessage(row, cache)),
      nextCursor: encodeQueryCursor(lastSeq),
      hasMore,
    };
  }

  const readConversationTx = db.transaction(
    (
      reader: Reader,
      conversation: ConversationId,
      range: Range | undefined,
      limit: number | undefined,
    ): MessagePage => {
      const row = st.getConversation.get({ id: conversation });
      if (row === undefined) throw notFound('conversation');
      // Current access only. A space rejoined after a gap reads its whole
      // history here, including what the stream skipped.
      requireReadAccess(reader, row.space_id as SpaceId, 'conversation');

      const plan = planQuery(range, limit);
      const statement =
        plan.order === 'oldest' ? st.conversationPage : st.conversationPageBackwards;
      const rows = statement.all({
        conversation,
        after: plan.after,
        since: plan.since,
        until: plan.until,
        limit: plan.limit + 1,
      });
      const page = pageMessages(rows, plan);
      if (reader.kind === 'agent') {
        writeRead(
          reader.id,
          'conversation',
          { conversation, range: range ?? null, limit: plan.limit },
          page.nextCursor,
          page.messages.length,
        );
      }
      return page;
    },
  );

  const readSpaceTx = db.transaction(
    (
      reader: Reader,
      space: SpaceId,
      range: Range | undefined,
      limit: number | undefined,
    ): MessagePage => {
      if (st.getSpace.get({ id: space }) === undefined) throw notFound('space');
      requireReadAccess(reader, space, 'space');

      const plan = planQuery(range, limit);
      const statement = plan.order === 'oldest' ? st.spacePage : st.spacePageBackwards;
      const rows = statement.all({
        space,
        after: plan.after,
        since: plan.since,
        until: plan.until,
        limit: plan.limit + 1,
      });
      const page = pageMessages(rows, plan);
      if (reader.kind === 'agent') {
        writeRead(
          reader.id,
          'space',
          { space, range: range ?? null, limit: plan.limit },
          page.nextCursor,
          page.messages.length,
        );
      }
      return page;
    },
  );

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  /**
   * `dgp_<agent-id>_<secret>`. The id travels in the clear so a rejected
   * authentication is still attributable — otherwise a mistyped key and an
   * agent that was never started are indistinguishable.
   */
  function parseKey(presented: string): { agent: AgentId } | undefined {
    const split = splitKey(presented);
    return split === undefined ? undefined : { agent: split.agent as AgentId };
  }

  const verifyKeyTx = db.transaction(
    (presented: string, countFailure: boolean): Authentication | undefined => {
      const parsed = parseKey(presented);
      const at = now();

      const fail = (): undefined => {
        // Counted against the id the key claimed, which is what it is: anyone
        // who knows an agent's id can send a bad key bearing it. Skipped once
        // the caller judges the attempts a flood, so a public counter cannot be
        // driven — and a write cannot be forced — without limit.
        if (
          countFailure &&
          parsed !== undefined &&
          st.getAgent.get({ id: parsed.agent }) !== undefined
        ) {
          st.countFailedAuth.run({ id: parsed.agent });
        }
        return undefined;
      };

      if (parsed === undefined) return fail();
      const row = st.keyByHash.get({ hash: sha256(presented) });
      if (row === undefined) return fail();
      if (row.revoked_at !== null) return fail();
      // The hash matched, so the id in the token is the id on the row; check it
      // anyway rather than trusting the caller's half of the string.
      if (row.agent_id !== parsed.agent) return fail();

      const agentRow = st.getAgent.get({ id: row.agent_id });
      if (agentRow === undefined || agentRow.archived === 1) return fail();

      st.touchAgent.run({ id: row.agent_id, at });
      const refreshed = st.getAgent.get({ id: row.agent_id });
      /* c8 ignore next */
      if (refreshed === undefined) throw new Error('agent vanished');
      return { agent: toAgentRecord(refreshed), keyId: row.id };
    },
  );

  // -------------------------------------------------------------------------
  // The Store
  // -------------------------------------------------------------------------

  const store: Store = {
    database: db,
    schema,
    reservedSequence: RESERVED_SEQUENCE,
    close() {
      db.close();
    },

    createAgent(displayName) {
      assertValidName('displayName', displayName);
      const id = newId();
      try {
        st.insertAgent.run({ id, name: displayName, at: now() });
      } catch (error) {
        throw uniqueOr(error, 'an agent with that name already exists');
      }
      return toAgentRecord(requireAgentRow(id as AgentId));
    },

    renameAgent(agent, displayName) {
      assertValidName('displayName', displayName);
      return renameAgentTx(agent, displayName);
    },

    archiveAgent(agent) {
      return archiveTx(agent);
    },

    unarchiveAgent(agent) {
      requireAgentRow(agent);
      // No key is issued here: Dogpark cannot re-show a hashed one, so the
      // caller issues a fresh key as a separate, visible step.
      st.setArchived.run({ id: agent, archived: 0 });
      return toAgentRecord(requireAgentRow(agent));
    },

    listAgents(opts) {
      return st.listAgents
        .all({ includeArchived: opts?.includeArchived === true ? 1 : 0 })
        .map(toAgentRecord);
    },

    getAgent(agent) {
      const row = st.getAgent.get({ id: agent });
      return row === undefined ? undefined : toAgentRecord(row);
    },

    listAgentsSharingSpaceWith(agent, space) {
      requireAgentRow(agent);
      if (space !== undefined) {
        requireSpaceRow(space);
        // Naming a space you are not in is a probe; answer it like any other.
        if (!isCurrentMember(agent, space)) throw notFound('space');
      }
      return st.peers
        .all({ agent, space: space ?? null })
        .map((row) => ({ id: row.id as AgentId, displayName: row.display_name }));
    },

    issueKey(agent, label) {
      const row = requireAgentRow(agent);
      if (row.archived === 1) {
        throw invalid('cannot issue a key to an archived agent; unarchive it first');
      }
      if (label !== undefined) assertNoReservedSequence('label', label);
      const id = newId();
      // Hex, not base64url: the key is split on '_' and base64url uses it.
      const secret = randomBytes(32).toString('hex');
      const key = `${KEY_PREFIX}_${agent}_${secret}`;
      const at = now();
      st.insertKey.run({ id, agent, hash: sha256(key), label: label ?? null, at });
      return { id, agent, key, createdAt: at };
    },

    verifyKey(presented, options) {
      return verifyKeyTx(presented, options?.countFailure ?? true);
    },

    revokeKey(keyId) {
      st.revokeKey.run({ id: keyId, at: now() });
    },

    listKeys(agent) {
      requireAgentRow(agent);
      return st.listKeys.all({ agent }).map((row) => ({
        id: row.id,
        agent: row.agent_id as AgentId,
        label: row.label,
        createdAt: row.created_at as Timestamp,
        revokedAt: row.revoked_at as Timestamp | null,
      }));
    },

    createSpace(name) {
      assertNonEmpty('name', name);
      const id = newId();
      try {
        st.insertSpace.run({ id, name, at: now() });
      } catch (error) {
        throw uniqueOr(error, 'a space with that name already exists');
      }
      return toSpace(requireSpaceRow(id as SpaceId));
    },

    renameSpace(space, name) {
      assertNonEmpty('name', name);
      requireSpaceRow(space);
      try {
        st.renameSpace.run({ id: space, name });
      } catch (error) {
        throw uniqueOr(error, 'a space with that name already exists');
      }
      return toSpace(requireSpaceRow(space));
    },

    listSpaces() {
      return st.listSpaces.all().map(toSpace);
    },

    getSpace(space) {
      const row = st.getSpace.get({ id: space });
      return row === undefined ? undefined : toSpace(row);
    },

    grantMembership(agent, space) {
      return grantTx(agent, space);
    },

    revokeMembership(agent, space) {
      return revokeTx(agent, space);
    },

    isCurrentMember,

    listSpacesForAgent(agent) {
      requireAgentRow(agent);
      return st.spacesForAgent.all({ agent }).map(toSpace);
    },

    listMembershipIntervals(filter) {
      return st.membershipIntervals
        .all({ agent: filter?.agent ?? null, space: filter?.space ?? null })
        .map((row) => ({
          id: row.id,
          agent: row.agent_id as AgentId,
          space: row.space_id as SpaceId,
          grantedAt: row.granted_at as Timestamp,
          revokedAt: row.revoked_at as Timestamp | null,
        }));
    },

    resolveOrCreateConversation(space, title, createdBy) {
      requireSpaceRow(space);
      assertNonEmpty('title', title);
      return toConversation(resolveConversationTx(space, title, createdBy));
    },

    getConversation(conversation) {
      const row = st.getConversation.get({ id: conversation });
      return row === undefined ? undefined : toConversation(row);
    },

    renameConversation(conversation, title) {
      assertNonEmpty('title', title);
      return renameConversationTx(conversation, title);
    },

    messageAsOf(message, at) {
      const row = st.messageById.get({ id: message });
      if (row === undefined) return undefined;
      return toMessage(row, newRenderCache(normalizeTimestamp('at', at)));
    },

    listConversationSummaries(space) {
      requireSpaceRow(space);
      return st.conversationSummaries.all({ space }).map((row) => ({
        ...toConversation(row),
        messageCount: row.message_count,
        lastActivityAt: row.last_sent_at as Timestamp | null,
        lastSender: toLastSender(row),
      }));
    },

    postMessage(input) {
      return postTx(input);
    },

    readStream(agent, args) {
      return readStreamTx(agent, args ?? {});
    },

    readConversation(reader, conversation, range, limit) {
      return readConversationTx(reader, conversation, range, limit);
    },

    readSpace(reader, space, range, limit) {
      return readSpaceTx(reader, space, range, limit);
    },

    searchMessages(query, opts) {
      // The human's search (architecture: the admin API). Mentions are
      // reference tokens in the indexed text, so searching for an agent means
      // searching for its id — and a rename touches no index.
      assertNoReservedSequence('query', query);
      const cache = newRenderCache();
      const limit = clampLimit(opts?.limit);
      let rows;
      try {
        rows = st.search.all({ query, space: opts?.space ?? null, limit });
      } catch (error) {
        // FTS5 parses the query itself and rejects bad syntax as a plain
        // SQLITE_ERROR — a typo surfacing as an internal fault. The query is
        // reported back unchanged and never rewritten into one that parses: a
        // search that quietly means something else is worse than one that says
        // it cannot be read.
        if (error instanceof Database.SqliteError && error.code === 'SQLITE_ERROR') {
          throw invalid(`search query is not valid FTS5 syntax: ${error.message}`);
        }
        throw error;
      }
      return rows.map((row) => ({
        message: toMessage(row, cache),
        // A snippet is a fragment of the stored body, so it is rendered like
        // the body: references become names, and the marker never leaves.
        snippet: renderSnippet(
          row.snippet,
          (agent) => mentionName(cache, row.space_id, agent),
          SNIPPET_OPEN,
          SNIPPET_CLOSE,
        ),
      }));
    },

    getAttachment(attachment) {
      const row = st.getAttachment.get({ id: attachment });
      if (row === undefined) return undefined;
      return {
        id: row.id as AttachmentId,
        filename: row.filename,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        message: row.message_id as MessageId,
        // Already joined for; withholding it only bought the caller a second
        // lookup to authorise a download.
        space: row.space_id as SpaceId,
      };
    },

    recordEscalation(input) {
      return escalateTx(input);
    },

    listEscalations(filter) {
      return st.listEscalations
        .all({
          state: filter?.state ?? null,
          dueAt: filter?.dueAt ?? null,
          limit: clampLimit(filter?.limit),
        })
        .map(toEscalation);
    },

    markEscalationNotification(escalation, state, opts) {
      if (st.getEscalation.get({ id: escalation }) === undefined) throw notFound('escalation');
      st.markEscalation.run({
        id: escalation,
        state,
        at: now(),
        error: opts?.error ?? null,
        next: opts?.nextAttemptAt ?? null,
      });
      const row = st.getEscalation.get({ id: escalation });
      /* c8 ignore next */
      if (row === undefined) throw new Error('escalation vanished');
      return toEscalation(row);
    },

    readReadLog(filter) {
      const limit = clampLimit(filter?.limit);
      const after = filter?.after === undefined ? undefined : decodeReadLogCursor(filter.after);
      const bounds: ReadLogBounds = {
        since: filter?.since === undefined ? null : normalizeTimestamp('since', filter.since),
        until: filter?.until === undefined ? null : normalizeTimestamp('until', filter.until),
        afterAt: after?.readAt ?? null,
        afterRow: after?.rowId ?? 0,
        // One more than asked for, so `hasMore` is observed and not guessed.
        limit: limit + 1,
      };
      const rows =
        filter?.agent === undefined
          ? st.listReads.all(bounds)
          : st.listReadsForAgent.all({ ...bounds, agent: filter.agent });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map(toReadLogEntry),
        // Like the message queries and unlike the stream: nothing is skipped,
        // so an empty page leaves the position exactly where it was.
        nextCursor:
          last === undefined
            ? (filter?.after ?? null)
            : encodeReadLogCursor({ readAt: last.read_at, rowId: last.row_id }),
        hasMore,
      };
    },

    lastReadCursor(agent) {
      const row = st.lastStreamRead.get({ agent });
      return row === undefined ? undefined : (row.cursor as Cursor);
    },

    recordAttachmentRead(agent, attachment, message) {
      requireAgentRow(agent);
      // No position comes back from a file, so the cursor is empty rather
      // than invented; the parameters say which file, and whose message.
      writeRead(agent, 'attachment', { attachment, message }, '', 1);
    },

    createSession(ttlSeconds) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw invalid('ttlSeconds must be a positive integer');
      }
      const id = newId();
      const token = randomBytes(32).toString('base64url');
      const createdAt = now();
      const expiresAt = new Date(clock().getTime() + ttlSeconds * 1000).toISOString() as Timestamp;
      st.insertSession.run({ id, hash: sha256(token), at: createdAt, expires: expiresAt });
      return { id, token, createdAt, expiresAt };
    },

    verifySession(token) {
      const row = st.sessionByHash.get({ hash: sha256(token) });
      if (row === undefined) return undefined;
      // Expiry is checked here rather than left to a sweep, so a stale row is
      // never a valid session even if nothing has swept.
      if (row.expires_at <= now()) return undefined;
      return {
        id: row.id,
        createdAt: row.created_at as Timestamp,
        expiresAt: row.expires_at as Timestamp,
      };
    },

    deleteSession(token) {
      return st.deleteSession.run({ hash: sha256(token) }).changes > 0;
    },

    deleteExpiredSessions() {
      return st.deleteExpiredSessions.run({ at: now() }).changes;
    },
  };

  return store;
}

/**
 * SQLite reports a violated unique index as an opaque error; turn the ones we
 * provoke deliberately into `invalid_request` and let anything else through
 * unchanged.
 */
function uniqueOr(error: unknown, message: string): unknown {
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
    return new StoreError('invalid_request', message);
  }
  return error;
}
