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
  QueryCursor,
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
import { decodeCursor, decodeQueryCursor, encodeCursor, encodeQueryCursor } from './cursors.js';
import { invalid, notFound, StoreError } from './errors.js';
import { newId } from './ids.js';
import { migrate } from './migrate.js';
import {
  assertNoReservedSequence,
  assertNonEmpty,
  assertValidName,
  encodeMentions,
  normalizeTimestamp,
  parseMentions,
  renderMentions,
  RESERVED_SEQUENCE,
} from './text.js';

export { StoreError } from './errors.js';
export { RESERVED_SEQUENCE } from './text.js';
export { migrate, MIGRATIONS } from './migrate.js';
export type { Migration, MigrateResult } from './migrate.js';

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
}

export interface PostMessageInput {
  readonly sender: Writer;
  readonly target: PostTarget;
  readonly body: string;
  readonly attachments?: readonly AttachmentInput[] | undefined;
  /** Scoped per agent, so the human cannot supply one. */
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

export type ReadKind = 'stream' | 'conversation' | 'space';

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
  id: string;
  agent_id: string;
  read_at: string;
  kind: string;
  params_json: string;
  cursor: string;
  item_count: number;
}

interface StreamRow {
  seq: number;
  kind: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const KEY_PREFIX = 'dgp';

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
  verifyKey(presented: string): Authentication | undefined;
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
  listSpaceMembers(space: SpaceId): readonly Agent[];
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
  listConversations(space: SpaceId): readonly Conversation[];

  // Messages
  postMessage(input: PostMessageInput): PostMessageResult;
  readStream(agent: AgentId, args?: ReadStreamArgs): StreamPage;
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
  getMessage(reader: Reader, message: MessageId): Message | undefined;
  searchMessages(
    query: string,
    options?: {
      readonly space?: SpaceId | undefined;
      readonly limit?: number | undefined;
    },
  ): readonly SearchHit[];
  getAttachment(
    attachment: AttachmentId,
  ): (Attachment & { readonly message: MessageId }) | undefined;

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
  recordRead(entry: {
    readonly agent: AgentId;
    readonly kind: ReadKind;
    readonly params: unknown;
    readonly cursor: string;
    readonly itemCount: number;
  }): void;
  listReadLog(filter?: {
    readonly agent?: AgentId | undefined;
    readonly limit?: number | undefined;
  }): readonly ReadLogEntry[];
  lastReadCursor(agent: AgentId): Cursor | undefined;

  // Sessions
  createSession(ttlSeconds: number): IssuedSession;
  verifySession(token: string): SessionRecord | undefined;
  deleteSession(token: string): boolean;
  deleteExpiredSessions(): number;
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

  migrate(db, undefined, now);

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
    spaceMembers: db.prepare<{ space: string }, AgentRow>(
      'SELECT a.* FROM agent a JOIN membership m ON m.agent_id = a.id ' +
        'WHERE m.space_id = @space AND m.revoked_seq IS NULL ORDER BY a.display_name',
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
    listConversations: db.prepare<{ space: string }, ConversationRow>(
      'SELECT id, space_id, title FROM conversation WHERE space_id = @space ORDER BY created_at, id',
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
    spacePage: db.prepare<
      { space: string; after: number; since: string | null; until: string | null; limit: number },
      MessageRow
    >(
      'SELECT * FROM message WHERE space_id = @space AND seq > @after ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq LIMIT @limit',
    ),
    search: db.prepare<
      { query: string; space: string | null; limit: number },
      MessageRow & { snippet: string }
    >(
      "SELECT m.*, snippet(message_fts, 0, '[', ']', '…', 24) AS snippet " +
        'FROM message_fts JOIN message m ON m.seq = message_fts.rowid ' +
        'WHERE message_fts MATCH @query AND (@space IS NULL OR m.space_id = @space) ' +
        'ORDER BY rank LIMIT @limit',
    ),

    getIdempotency: db.prepare<
      { agent: string; key: string },
      { request_hash: string; outcome_json: string }
    >('SELECT request_hash, outcome_json FROM idempotency WHERE agent_id = @agent AND key = @key'),
    putIdempotency: db.prepare<
      { agent: string; key: string; hash: string; outcome: string; at: string },
      unknown
    >(
      'INSERT INTO idempotency (agent_id, key, request_hash, outcome_json, created_at) ' +
        'VALUES (@agent, @key, @hash, @outcome, @at)',
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
    listReads: db.prepare<{ agent: string | null; limit: number }, ReadLogRow>(
      'SELECT * FROM read_log WHERE (@agent IS NULL OR agent_id = @agent) ' +
        'ORDER BY read_at DESC, rowid DESC LIMIT @limit',
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
  }

  function newRenderCache(): RenderCache {
    return { titles: new Map(), names: new Map(), mentionNames: new Map() };
  }

  function conversationTitle(cache: RenderCache, id: string): string {
    const cached = cache.titles.get(id);
    if (cached !== undefined) return cached;
    const row = st.getConversation.get({ id });
    /* c8 ignore next */
    if (row === undefined) throw new Error(`message references a missing conversation ${id}`);
    cache.titles.set(id, row.title);
    return row.title;
  }

  function agentName(cache: RenderCache, id: string): string {
    const cached = cache.names.get(id);
    if (cached !== undefined) return cached;
    const row = st.getAgent.get({ id });
    /* c8 ignore next */
    if (row === undefined) throw new Error(`message references a missing agent ${id}`);
    cache.names.set(id, row.display_name);
    return row.display_name;
  }

  function mentionName(cache: RenderCache, space: string, agent: AgentId): string | undefined {
    const key = `${space} ${agent}`;
    if (cache.mentionNames.has(key)) return cache.mentionNames.get(key);
    const row = st.resolveMentionRef.get({ space, agent });
    const name = row?.display_name;
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

    if (sender.kind === 'human' && input.idempotencyKey !== undefined) {
      throw invalid('idempotency keys are scoped per agent');
    }

    // Validate before anything else, including before the idempotency lookup:
    // a rejected write should be rejected identically whether or not its key
    // has been seen, and the reserved sequence must never reach a stored row.
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
      attachments: (input.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
      })),
    });

    if (sender.kind === 'agent' && input.idempotencyKey !== undefined) {
      const existing = st.getIdempotency.get({ agent: sender.id, key: input.idempotencyKey });
      if (existing !== undefined) {
        // A different request under the same key is an error, not a silent
        // replay of the old answer.
        if (!constantTimeEquals(existing.request_hash, hash)) {
          throw invalid('idempotency key was already used for a different request');
        }
        const outcome = JSON.parse(existing.outcome_json) as PostOutcome;
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
    if (sender.kind === 'agent' && input.idempotencyKey !== undefined) {
      const outcome: PostOutcome = { messageId: id };
      st.putIdempotency.run({
        agent: sender.id,
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

    const existing = st.getIdempotency.get({ agent: input.agent, key: input.idempotencyKey });
    if (existing !== undefined) {
      if (!constantTimeEquals(existing.request_hash, hash)) {
        throw invalid('idempotency key was already used for a different request');
      }
      const outcome = JSON.parse(existing.outcome_json) as EscalationOutcomeRecord;
      const row = st.getEscalation.get({ id: outcome.escalationId });
      /* c8 ignore next */
      if (row === undefined) throw new Error('escalation vanished');
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
      agent: input.agent,
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
    const nextSeqValue = lastSeq ?? Math.max(0, after);
    const nextCursor = encodeCursor(nextSeqValue);

    writeRead(agent, 'stream', { from: args.from ?? null, limit }, nextCursor, items.length);
    return { items, nextCursor, hasMore };
  });

  interface QueryPlan {
    readonly after: number;
    readonly since: string | null;
    readonly until: string | null;
    readonly limit: number;
  }

  function planQuery(range: Range | undefined, limit: number | undefined): QueryPlan {
    return {
      after: range?.after === undefined ? 0 : decodeQueryCursor(range.after),
      since: range?.since === undefined ? null : normalizeTimestamp('since', range.since),
      until: range?.until === undefined ? null : normalizeTimestamp('until', range.until),
      limit: clampLimit(limit),
    };
  }

  /**
   * A query, not a stream position. Nothing is skipped, so the cursor is the
   * last row returned and an empty page leaves the position where it was —
   * unlike the stream, whose cursor jumps past what the access filter removed.
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
      const rows = st.conversationPage.all({
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
      const rows = st.spacePage.all({
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
    const parts = presented.split('_');
    if (parts.length !== 3) return undefined;
    const [prefix, agent, secret] = parts;
    if (prefix !== KEY_PREFIX || agent === undefined || !secret) return undefined;
    return { agent: agent as AgentId };
  }

  const verifyKeyTx = db.transaction((presented: string): Authentication | undefined => {
    const parsed = parseKey(presented);
    const at = now();

    const fail = (): undefined => {
      // Counted against the id the key claimed, which is what it is: anyone
      // who knows an agent's id can send a bad key bearing it.
      if (parsed !== undefined && st.getAgent.get({ id: parsed.agent }) !== undefined) {
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
  });

  // -------------------------------------------------------------------------
  // The Store
  // -------------------------------------------------------------------------

  const store: Store = {
    database: db,
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
      requireAgentRow(agent);
      try {
        st.renameAgent.run({ id: agent, name: displayName });
      } catch (error) {
        throw uniqueOr(error, 'an agent with that name already exists');
      }
      return toAgentRecord(requireAgentRow(agent));
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

    verifyKey(presented) {
      return verifyKeyTx(presented);
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

    listSpaceMembers(space) {
      requireSpaceRow(space);
      return st.spaceMembers
        .all({ space })
        .map((row) => ({ id: row.id as AgentId, displayName: row.display_name }));
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
      const row = st.getConversation.get({ id: conversation });
      if (row === undefined) throw notFound('conversation');
      assertNonEmpty('title', title);
      try {
        st.renameConversation.run({ id: conversation, title });
      } catch (error) {
        throw uniqueOr(error, 'a conversation with that title already exists in this space');
      }
      const renamed = st.getConversation.get({ id: conversation });
      /* c8 ignore next */
      if (renamed === undefined) throw new Error('conversation vanished');
      return toConversation(renamed);
    },

    listConversations(space) {
      requireSpaceRow(space);
      return st.listConversations.all({ space }).map(toConversation);
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

    getMessage(reader, message) {
      const row = st.messageById.get({ id: message });
      if (row === undefined) return undefined;
      if (reader.kind === 'agent' && !isCurrentMember(reader.id, row.space_id as SpaceId)) {
        return undefined;
      }
      return toMessage(row, newRenderCache());
    },

    searchMessages(query, opts) {
      // The human's search (architecture: the admin API). Mentions are
      // reference tokens in the indexed text, so searching for an agent means
      // searching for its id — and a rename touches no index.
      assertNoReservedSequence('query', query);
      const cache = newRenderCache();
      return st.search
        .all({ query, space: opts?.space ?? null, limit: clampLimit(opts?.limit) })
        .map((row) => ({ message: toMessage(row, cache), snippet: row.snippet }));
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

    recordRead(entry) {
      requireAgentRow(entry.agent);
      writeRead(entry.agent, entry.kind, entry.params, entry.cursor, entry.itemCount);
    },

    listReadLog(filter) {
      return st.listReads
        .all({ agent: filter?.agent ?? null, limit: clampLimit(filter?.limit) })
        .map((row) => ({
          id: row.id,
          agent: row.agent_id as AgentId,
          readAt: row.read_at as Timestamp,
          kind: row.kind as ReadKind,
          params: JSON.parse(row.params_json) as unknown,
          cursor: row.cursor,
          itemCount: row.item_count,
        }));
    },

    lastReadCursor(agent) {
      const row = st.lastStreamRead.get({ agent });
      return row === undefined ? undefined : (row.cursor as Cursor);
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
