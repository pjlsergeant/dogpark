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
  Message,
  MessageId,
  MessagePage,
  Range,
  Space,
  SpaceId,
  StreamPage,
  Timestamp,
} from '../types.js';
import { agentStore } from './agents.js';
import { conversationStore } from './conversations.js';
import { createContext } from './context.js';
import { escalationStore } from './escalations.js';
import { newId } from './ids.js';
import { messageStore } from './messages.js';
import { migrate } from './migrate.js';
import type { MigrateResult } from './migrate.js';
import { readLogStore } from './reads.js';
import type {
  AgentRecord,
  ConversationSummary,
  EscalationOutcome,
  EscalationRecord,
  IssuedKey,
  IssuedSession,
  KeyRecord,
  MembershipInterval,
  NotificationState,
  PostMessageInput,
  PostMessageResult,
  Reader,
  ReadLogFilter,
  ReadLogPage,
  ReadStreamArgs,
  RecordEscalationInput,
  SearchHit,
  SessionRecord,
  StoreOptions,
} from './records.js';
import { sessionStore } from './sessions.js';
import { spaceStore } from './spaces.js';
import { RESERVED_SEQUENCE } from './text.js';

export { StoreError } from './errors.js';
export { RESERVED_SEQUENCE } from './text.js';
/** The two pieces of key handling the HTTP layer shares with the store. */
export { constantTimeEquals, splitKey } from './ids.js';
export { MAX_PAGE_LIMIT } from './limits.js';
export { migrate, MIGRATIONS } from './migrate.js';
export type { Migration, MigrateResult } from './migrate.js';
export type { ReadLogCursor } from './cursors.js';
export type * from './records.js';

/**
 * Mints an attachment id for the caller, which writes the file under it before
 * the message row commits (`AttachmentInput.id`). The only minter exported:
 * every other id is the store's own, and a caller that can mint one can
 * collide with one.
 */
export function newAttachmentId(): AttachmentId {
  return newId() as AttachmentId;
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

  // Before the statements are prepared: they name the tables.
  const schema = migrate(db, undefined, now);
  const ctx = createContext(db, { clock, now, humanDisplayName: options.humanDisplayName });

  return {
    database: db,
    schema,
    reservedSequence: RESERVED_SEQUENCE,
    close() {
      db.close();
    },
    ...agentStore(ctx),
    ...spaceStore(ctx),
    ...conversationStore(ctx),
    ...messageStore(ctx),
    ...readLogStore(ctx),
    ...escalationStore(ctx),
    ...sessionStore(ctx),
  };
}
