// Admin response bodies, as pinned by "Admin response shapes" in docs/http-api.md.
import type {
  AgentRecord,
  ConversationSummary,
  EscalationRecord,
  KeyRecord,
  ReadLogEntry,
  SearchHit,
  Store,
} from '../store/index.js';
import type { Agent, AgentId, SpaceId } from '../types.js';

function lookupAgent(store: Store, cache: Map<string, Agent>, id: AgentId): Agent {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const record = store.getAgent(id);
  // An agent row is never deleted, so the fallback is unreachable in practice;
  // it exists so a forensic list cannot be blanked by one missing row.
  const agent: Agent = { id, displayName: record?.displayName ?? id };
  cache.set(id, agent);
  return agent;
}

export function bare(agent: { readonly id: AgentId; readonly displayName: string }): Agent {
  return { id: agent.id, displayName: agent.displayName };
}

/** `keyId` everywhere a key summary appears — inside `GET /agents` too. */
export function keySummary(key: KeyRecord): unknown {
  return {
    keyId: key.id,
    label: key.label,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
  };
}

/**
 * `hasEverAuthenticated` is `lastSeenAt !== null`, since the store sets
 * last-seen only on a successful verification. The UI shows the failure count
 * prominently until it flips, which is the window where the count diagnoses
 * anything.
 */
export function adminAgent(record: AgentRecord, keys: readonly KeyRecord[]): unknown {
  return {
    id: record.id,
    displayName: record.displayName,
    archived: record.archived,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    failedAttemptsClaimingId: record.failedAuthAttempts,
    hasEverAuthenticated: record.lastSeenAt !== null,
    keys: keys.map(keySummary),
  };
}

/**
 * Membership is history: append-only intervals, with the current set being the
 * open ones (ADR-0011). `history` is the closed ones — what the contract calls
 * past intervals.
 */
export function spaceMembers(store: Store, space: SpaceId): unknown {
  const intervals = store.listMembershipIntervals({ space });
  const cache = new Map<string, Agent>();
  return {
    current: intervals
      .filter((interval) => interval.revokedAt === null)
      .map((interval) => ({
        agent: lookupAgent(store, cache, interval.agent),
        grantedAt: interval.grantedAt,
      })),
    history: intervals
      .filter((interval) => interval.revokedAt !== null)
      .map((interval) => ({
        agent: lookupAgent(store, cache, interval.agent),
        grantedAt: interval.grantedAt,
        revokedAt: interval.revokedAt,
      })),
  };
}

/**
 * One row of the human's thread list.
 *
 * `lastSender` is the whole `Sender`, not a name, so the UI renders an agent's
 * current name rather than one frozen when the message was written.
 */
export function conversationRow(summary: ConversationSummary): unknown {
  return {
    id: summary.id,
    space: summary.space,
    title: summary.title,
    messageCount: summary.messageCount,
    lastActivityAt: summary.lastActivityAt,
    lastSender: summary.lastSender,
  };
}

export function readLogRow(store: Store, cache: Map<string, Agent>, entry: ReadLogEntry): unknown {
  return {
    id: entry.id,
    agent: lookupAgent(store, cache, entry.agent),
    at: entry.readAt,
    kind: entry.kind,
    parameters: entry.params,
    cursor: entry.cursor,
    itemCount: entry.itemCount,
  };
}

export function escalationRow(
  store: Store,
  cache: Map<string, Agent>,
  record: EscalationRecord,
): unknown {
  return {
    id: record.id,
    agent: lookupAgent(store, cache, record.agent),
    conversation: store.getConversation(record.conversation),
    reason: record.reason,
    raisedAt: record.createdAt,
    notification: {
      state: record.notificationState,
      attempts: record.attempts,
      lastAttemptAt: record.lastAttemptAt,
      nextAttemptAt: record.nextAttemptAt,
      lastError: record.lastError,
    },
  };
}

export function searchRow(store: Store, hit: SearchHit): unknown {
  return {
    message: hit.message,
    conversation: {
      id: hit.message.conversation,
      space: hit.message.space,
      title: hit.message.conversationTitle,
    },
    space: store.getSpace(hit.message.space),
    snippet: hit.snippet,
  };
}
