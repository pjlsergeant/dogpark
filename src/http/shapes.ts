// Admin response bodies. Each function's return type is the response schema's
// inferred type (src/types.ts), so the compiler checks what is built here
// against the one contract the smoke tests parse against.
import type {
  AgentRecord,
  ConversationSummary as StoreConversationSummary,
  EscalationRecord,
  KeyRecord,
  ReadLogEntry as StoreReadLogEntry,
  SearchHit,
  Store,
} from '../store/index.js';
import type {
  AdminAgent,
  Agent,
  AgentId,
  ApiKeySummary,
  ConversationId,
  ConversationSummary,
  Escalation,
  ReadLogEntry,
  SearchResult,
  SpaceId,
  SpaceMembers,
} from '../types.js';

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
export function keySummary(key: KeyRecord): ApiKeySummary {
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
export function adminAgent(
  record: AgentRecord,
  keys: readonly KeyRecord[],
  description?: string,
): AdminAgent {
  return {
    id: record.id,
    displayName: record.displayName,
    archived: record.archived,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    failedAttemptsClaimingId: record.failedAuthAttempts,
    hasEverAuthenticated: record.lastSeenAt !== null,
    keys: keys.map(keySummary),
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * Membership is history: append-only intervals, with the current set being the
 * open ones (ADR-0011). `history` is the closed ones — what the contract calls
 * past intervals.
 */
export function spaceMembers(store: Store, space: SpaceId): SpaceMembers {
  const intervals = store.listMembershipIntervals({ space });
  const cache = new Map<string, Agent>();
  return {
    current: intervals
      .filter((interval) => interval.revokedAt === null)
      .map((interval) => {
        const note = store.getMembershipNote(interval.agent, space);
        return {
          agent: lookupAgent(store, cache, interval.agent),
          grantedAt: interval.grantedAt,
          ...(note === undefined ? {} : { note }),
        };
      }),
    history: intervals
      .filter((interval) => interval.revokedAt !== null)
      .map((interval) => ({
        agent: lookupAgent(store, cache, interval.agent),
        grantedAt: interval.grantedAt,
        // The filter above keeps only closed intervals, so this is never null.
        revokedAt: interval.revokedAt as NonNullable<typeof interval.revokedAt>,
      })),
  };
}

/**
 * One row of the human's thread list.
 *
 * `openedBy` and `lastSender` are whole `Sender`s, not names, so the UI
 * renders an agent's current name rather than one frozen at the time.
 */
export function conversationRow(summary: StoreConversationSummary): ConversationSummary {
  return {
    id: summary.id,
    space: summary.space,
    title: summary.title,
    openedBy: summary.openedBy,
    messageCount: summary.messageCount,
    lastActivityAt: summary.lastActivityAt,
    lastSender: summary.lastSender,
  };
}

/**
 * A read-log row, with what it read resolved far enough to link into the
 * reader: the conversation (and so its space) for a conversation read, the
 * space for a space read. Both as current labels.
 *
 * `collapsedCount` and `firstReadAt` appear only on a row that stands for a
 * compacted run of empty polls, so an ordinary row still reads as one read.
 * The stream tip the row recorded is not exposed: like `label_seq`, it is
 * machinery for reconstruction rather than something the row asserts.
 */
export function readLogRow(
  store: Store,
  cache: Map<string, Agent>,
  entry: StoreReadLogEntry,
): ReadLogEntry {
  const params = entry.params as { conversation?: unknown; space?: unknown } | null;
  const conversation =
    entry.kind === 'conversation' && typeof params?.conversation === 'string'
      ? store.getConversation(params.conversation as ConversationId)
      : undefined;
  const space =
    entry.kind === 'space' && typeof params?.space === 'string'
      ? store.getSpace(params.space as SpaceId)
      : undefined;
  return {
    id: entry.id,
    agent: lookupAgent(store, cache, entry.agent),
    at: entry.readAt,
    kind: entry.kind,
    parameters: (entry.params ?? {}) as Record<string, unknown>,
    cursor: entry.cursor,
    itemCount: entry.itemCount,
    ...(entry.collapsedCount > 1
      ? {
          collapsedCount: entry.collapsedCount,
          ...(entry.firstReadAt === undefined ? {} : { firstReadAt: entry.firstReadAt }),
        }
      : {}),
    ...(conversation === undefined ? {} : { conversation }),
    ...(space === undefined ? {} : { space }),
  };
}

/**
 * An escalation's conversation is guaranteed by a foreign key; the store's
 * lookup is nullable for callers who might ask about a stranger, so the
 * invariant is asserted here rather than widening the response shape.
 */
function present<T>(value: T | undefined, what: string): T {
  /* c8 ignore next */
  if (value === undefined) throw new Error(`a forensic row references a missing ${what}`);
  return value;
}

export function escalationRow(
  store: Store,
  cache: Map<string, Agent>,
  record: EscalationRecord,
): Escalation {
  return {
    id: record.id as Escalation['id'],
    agent: lookupAgent(store, cache, record.agent),
    conversation: present(store.getConversation(record.conversation), 'conversation'),
    reason: record.reason,
    raisedAt: record.createdAt,
    acknowledgedAt: record.acknowledgedAt,
    notification: {
      state: record.notificationState,
      attempts: record.attempts,
      lastAttemptAt: record.lastAttemptAt,
      nextAttemptAt: record.nextAttemptAt,
      lastError: record.lastError,
    },
  };
}

export function searchRow(store: Store, hit: SearchHit): SearchResult {
  return {
    message: hit.message,
    conversation: {
      id: hit.message.conversation,
      space: hit.message.space,
      title: hit.message.conversationTitle,
    },
    space: present(store.getSpace(hit.message.space), 'space'),
    snippet: hit.snippet,
  };
}
