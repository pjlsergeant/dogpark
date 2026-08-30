/**
 * What every domain module is built over: the connection, the prepared
 * statements, the clock, and the handful of lookups they all share.
 */
import { createHash } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type { AgentId, Conversation, ConversationId, Space, SpaceId, Timestamp } from '../types.js';
import { invalid, notFound, StoreError } from './errors.js';
import { MAX_PAGE_LIMIT } from './limits.js';
import type { AgentRecord, Reader } from './records.js';
import { prepareStatements } from './statements.js';
import type { AgentRow, ConversationRow, SpaceRow, Statements } from './statements.js';

export { constantTimeEquals } from './ids.js';

export interface StoreContext {
  readonly db: Db;
  readonly st: Statements;
  readonly clock: () => Date;
  readonly now: () => Timestamp;
  /** There is no user record, so the human's name comes from configuration. */
  readonly humanDisplayName: string;
  nextSeq(): number;
  tip(): number;
  toAgentRecord(row: AgentRow): AgentRecord;
  toSpace(row: SpaceRow): Space;
  toConversation(row: ConversationRow): Conversation;
  requireAgentRow(agent: AgentId): AgentRow;
  requireSpaceRow(space: SpaceId): SpaceRow;
  isCurrentMember(agent: AgentId, space: SpaceId): boolean;
  requireReadAccess(reader: Reader, space: SpaceId, what: string): void;
}

export function createContext(
  db: Db,
  options: {
    readonly clock: () => Date;
    readonly now: () => Timestamp;
    readonly humanDisplayName: string;
  },
): StoreContext {
  const st = prepareStatements(db);

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

  return {
    db,
    st,
    clock: options.clock,
    now: options.now,
    humanDisplayName: options.humanDisplayName,
    nextSeq,
    tip,
    toAgentRecord,
    toSpace,
    toConversation,
    requireAgentRow,
    requireSpaceRow,
    isCurrentMember,
    requireReadAccess,
  };
}

const DEFAULT_LIMIT = 100;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer');
  return Math.min(limit, MAX_PAGE_LIMIT);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable field order, so the same request always hashes the same way. */
export function requestHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

/**
 * SQLite reports a violated unique index as an opaque error; turn the ones we
 * provoke deliberately into `invalid_request` and let anything else through
 * unchanged.
 */
export function uniqueOr(error: unknown, message: string): unknown {
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
    return new StoreError('invalid_request', message);
  }
  return error;
}
