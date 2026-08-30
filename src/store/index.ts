import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { AttachmentId, Timestamp } from '../types.js';
import { agentStore } from './agents.js';
import { conversationResolver, conversationStore } from './conversations.js';
import { createContext } from './context.js';
import { escalationStore } from './escalations.js';
import { newId } from './ids.js';
import { messageStore } from './messages.js';
import { migrate } from './migrate.js';
import { readLogStore } from './read-log.js';
import type { Store, StoreOptions } from './records.js';
import { sessionStore } from './sessions.js';
import { spaceStore } from './spaces.js';
import { RESERVED_SEQUENCE } from './text.js';

export { StoreError } from './errors.js';
export { RESERVED_SEQUENCE } from './text.js';
// The two pieces of key handling the HTTP layer shares with the store.
export { constantTimeEquals } from './hash.js';
export { splitKey } from './ids.js';
export { MAX_PAGE_LIMIT } from './limits.js';
export { migrate, MIGRATIONS } from './migrate.js';
export type { Migration, MigrateResult } from './migrate.js';
export type { EscalationCursor, ReadLogCursor } from './cursors.js';
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

  // Before the statements are prepared: they name the tables.
  const schema = migrate(db, undefined, now);
  const ctx = createContext(db, { now, humanDisplayName });
  const resolveConversation = conversationResolver(ctx);

  const base = {
    database: db,
    schema,
    reservedSequence: RESERVED_SEQUENCE,
    close() {
      db.close();
    },
  };
  const agents = agentStore(ctx);
  const spaces = spaceStore(ctx);
  const conversations = conversationStore(ctx, resolveConversation);
  const messages = messageStore(ctx, resolveConversation);
  const readLog = readLogStore(ctx);
  const escalations = escalationStore(ctx);
  const sessions = sessionStore(ctx);
  assertDisjoint(base, agents, spaces, conversations, messages, readLog, escalations, sessions);

  return {
    ...base,
    ...agents,
    ...spaces,
    ...conversations,
    ...messages,
    ...readLog,
    ...escalations,
    ...sessions,
  };
}

/**
 * Each domain module implements its own slice of `Store`. The type checker
 * proves the union covers the interface; it does not notice two modules
 * claiming the same method, which the spread would settle silently by order.
 */
function assertDisjoint(...parts: readonly object[]): void {
  const seen = new Set<string>();
  for (const part of parts) {
    for (const key of Object.keys(part)) {
      if (seen.has(key)) throw new Error(`two store modules define ${key}`);
      seen.add(key);
    }
  }
}
