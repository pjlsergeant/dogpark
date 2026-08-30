/**
 * What every domain module is built over: the connection, the prepared
 * statements, the clock as a timestamp, and the lookups more than one of them
 * shares.
 */
import type { Database as Db } from 'better-sqlite3';
import type { AgentId, Conversation, ConversationId, Space, SpaceId, Timestamp } from '../types.js';
import { notFound } from './errors.js';
import { prepareStatements } from './statements.js';
import type { AgentRow, ConversationRow, SpaceRow, Statements } from './statements.js';

export interface StoreContext {
  readonly db: Db;
  readonly st: Statements;
  readonly now: () => Timestamp;
  /** There is no user record, so the human's name comes from configuration. */
  readonly humanDisplayName: string;
  nextSeq(): number;
  toSpace(row: SpaceRow): Space;
  toConversation(row: ConversationRow): Conversation;
  requireAgentRow(agent: AgentId): AgentRow;
  requireSpaceRow(space: SpaceId): SpaceRow;
  isCurrentMember(agent: AgentId, space: SpaceId): boolean;
}

export function createContext(
  db: Db,
  options: {
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

  return {
    db,
    st,
    now: options.now,
    humanDisplayName: options.humanDisplayName,
    nextSeq,
    toSpace,
    toConversation,
    requireAgentRow,
    requireSpaceRow,
    isCurrentMember,
  };
}
