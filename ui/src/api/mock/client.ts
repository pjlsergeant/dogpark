/**
 * A fixture-backed stand-in for the admin API, so screens can be built and
 * looked at before a server exists.
 *
 * Development only. It is reached exactly once, from `api/index.ts`, behind
 * `import.meta.env.VITE_DOGPARK_MOCK` and a dynamic import — so a production
 * build never loads it. It implements the same interface as the real client
 * and knows nothing the real one does not: same shapes, same errors, same
 * once-only key.
 */
import type { ConversationQuery, DogparkAdminApi } from '../api.js';
import type {
  AdminAgent,
  AgentId,
  ApiKeyId,
  Conversation,
  ConversationId,
  Escalation,
  HumanPostRequest,
  IssuedKey,
  Message,
  MessageId,
  Page,
  ReadLogEntry,
  ReadLogFilter,
  SearchQuery,
  SearchResult,
  Space,
  SpaceId,
  SpaceMembers,
  Timestamp,
} from '../types.js';
import { ApiError } from '../types.js';
import * as fixtures from './fixtures.js';

/** The password the mock accepts. Printed on the login screen in mock mode. */
export const MOCK_PASSWORD = 'dogpark';

const latency = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 90));

const now = (): Timestamp => new Date().toISOString() as Timestamp;

let counter = 0;
const nextId = (prefix: string): string =>
  `${prefix}_${(++counter).toString(36)}${Date.now().toString(36)}`;

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createMockApi(): DogparkAdminApi {
  const spaces: Space[] = [...fixtures.spaces];
  const agents: AdminAgent[] = fixtures.agents.map((a) => ({ ...a, keys: [...a.keys] }));
  const conversations: Conversation[] = [...fixtures.conversations];
  const messages: Message[] = [...fixtures.messages];
  const memberships = [...fixtures.memberships];
  const reads: ReadLogEntry[] = [...fixtures.reads];
  const escalations: Escalation[] = [...fixtures.escalations];
  const seenIdempotencyKeys = new Map<string, Message>();

  let authenticated = false;

  function requireSession(): void {
    if (!authenticated) {
      throw new ApiError({ code: 'unauthenticated', message: 'No session.', status: 401 });
    }
  }

  function agentOr404(id: AgentId): AdminAgent {
    const found = agents.find((a) => a.id === id);
    if (found === undefined) {
      throw new ApiError({ code: 'not_found', message: 'No such agent.', status: 404 });
    }
    return found;
  }

  function replace(agent: AdminAgent, changes: Partial<AdminAgent>): AdminAgent {
    const updated = { ...agent, ...changes };
    agents.splice(agents.indexOf(agent), 1, updated);
    return updated;
  }

  function issue(agent: AdminAgent, label: string | null): IssuedKey {
    const id = fixtures.keyId(nextId('key'));
    const updated = replace(agent, {
      keys: [...agent.keys, { id, label, createdAt: now(), revokedAt: null }],
    });
    return { agent: updated, keyId: id, key: `dgp_${agent.id}_${randomSecret()}` };
  }

  function page<T>(items: readonly T[]): Page<T> {
    return { items, nextCursor: null, hasMore: false };
  }

  return {
    kind: 'mock',

    async login(password) {
      await latency();
      if (password !== MOCK_PASSWORD) {
        throw new ApiError({ code: 'unauthenticated', message: 'Wrong password.', status: 401 });
      }
      authenticated = true;
      return { csrfToken: 'mock-csrf-token', displayName: 'you' };
    },
    async resume() {
      await latency();
      return authenticated ? { csrfToken: 'mock-csrf-token', displayName: 'you' } : null;
    },
    async logout() {
      await latency();
      authenticated = false;
    },

    async listSpaces() {
      await latency();
      requireSession();
      return [...spaces].sort((a, b) => a.name.localeCompare(b.name));
    },
    async createSpace(name) {
      await latency();
      requireSession();
      if (spaces.some((s) => s.name === name)) {
        throw new ApiError({
          code: 'invalid_request',
          message: 'That name is taken.',
          status: 409,
        });
      }
      const space: Space = { id: nextId('spc') as SpaceId, name };
      spaces.push(space);
      return space;
    },
    async renameSpace(id, name) {
      await latency();
      requireSession();
      const index = spaces.findIndex((s) => s.id === id);
      const existing = spaces[index];
      if (existing === undefined) {
        throw new ApiError({ code: 'not_found', message: 'No such space.', status: 404 });
      }
      const renamed = { ...existing, name };
      spaces.splice(index, 1, renamed);
      return renamed;
    },
    async listMembers(id) {
      await latency();
      requireSession();
      const space = spaces.find((s) => s.id === id);
      if (space === undefined) {
        throw new ApiError({ code: 'not_found', message: 'No such space.', status: 404 });
      }
      const intervals = memberships
        .filter((m) => m.space === id)
        .map((m) => {
          const agent = agents.find((a) => a.id === m.agent);
          return {
            agent: { id: m.agent, displayName: agent?.displayName ?? m.agent },
            grantedAt: m.grantedAt,
            revokedAt: m.revokedAt,
          };
        });
      return {
        space,
        current: intervals.filter((i) => i.revokedAt === null).map((i) => i.agent),
        intervals,
      } satisfies SpaceMembers;
    },
    async addMember(space, agent) {
      await latency();
      requireSession();
      agentOr404(agent);
      if (memberships.some((m) => m.space === space && m.agent === agent && m.revokedAt === null)) {
        return;
      }
      memberships.push({ agent, space, grantedAt: now(), revokedAt: null });
    },
    async removeMember(space, agent) {
      await latency();
      requireSession();
      const index = memberships.findIndex(
        (m) => m.space === space && m.agent === agent && m.revokedAt === null,
      );
      const open = memberships[index];
      if (open !== undefined) memberships.splice(index, 1, { ...open, revokedAt: now() });
    },

    async listAgents() {
      await latency();
      requireSession();
      return [...agents].sort((a, b) => a.displayName.localeCompare(b.displayName));
    },
    async createAgent(name) {
      await latency();
      requireSession();
      if (agents.some((a) => a.displayName === name)) {
        throw new ApiError({
          code: 'invalid_request',
          message: 'That name is taken.',
          status: 409,
        });
      }
      const agent: AdminAgent = {
        id: nextId('agt') as AgentId,
        displayName: name,
        archived: false,
        createdAt: now(),
        lastSeenAt: null,
        failedAuthAttempts: 0,
        keys: [],
      };
      agents.push(agent);
      return issue(agent, 'initial');
    },
    async renameAgent(id, name) {
      await latency();
      requireSession();
      return replace(agentOr404(id), { displayName: name });
    },
    async issueKey(id, label) {
      await latency();
      requireSession();
      return issue(agentOr404(id), label ?? null);
    },
    async revokeKey(agent, key) {
      await latency();
      requireSession();
      const found = agentOr404(agent);
      replace(found, {
        keys: found.keys.map((k) => (k.id === (key as ApiKeyId) ? { ...k, revokedAt: now() } : k)),
      });
    },
    async archiveAgent(id) {
      await latency();
      requireSession();
      const agent = agentOr404(id);
      return replace(agent, {
        archived: true,
        keys: agent.keys.map((k) => (k.revokedAt === null ? { ...k, revokedAt: now() } : k)),
      });
    },
    async unarchiveAgent(id) {
      await latency();
      requireSession();
      return issue(replace(agentOr404(id), { archived: false }), 'unarchived');
    },

    async listConversations(space) {
      await latency();
      requireSession();
      return fixtures
        .conversationSummaries()
        .concat(
          conversations
            .filter((c) => !fixtures.conversations.includes(c))
            .map((c) => ({ ...c, messageCount: 0, lastMessageAt: null, lastSenderName: null })),
        )
        .filter((c) => c.space === space)
        .map((summary) => {
          const inThread = messages.filter((m) => m.conversation === summary.id);
          const last = inThread[inThread.length - 1];
          return {
            ...summary,
            messageCount: inThread.length,
            lastMessageAt: last?.sentAt ?? null,
            lastSenderName: last?.sender.displayName ?? null,
          };
        })
        .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    },
    async readConversation(id: ConversationId, _query?: ConversationQuery) {
      await latency();
      requireSession();
      return {
        messages: messages.filter((m) => m.conversation === id),
        nextCursor: null,
        hasMore: false,
      };
    },
    async post(request: HumanPostRequest) {
      await latency();
      requireSession();
      const replayed = seenIdempotencyKeys.get(request.idempotencyKey);
      if (replayed !== undefined) {
        const conversation = conversations.find((c) => c.id === replayed.conversation);
        return { message: replayed, conversation: conversation as Conversation };
      }
      const target = request.target;
      let conversation: Conversation | undefined;
      if ('conversation' in target) {
        conversation = conversations.find((c) => c.id === target.conversation);
      } else {
        const { space, title } = target;
        conversation = conversations.find((c) => c.space === space && c.title === title);
        if (conversation === undefined) {
          conversation = { id: nextId('cnv') as ConversationId, space, title };
          conversations.push(conversation);
        }
      }
      if (conversation === undefined) {
        throw new ApiError({ code: 'not_found', message: 'No such conversation.', status: 404 });
      }
      const message: Message = {
        kind: 'message',
        id: nextId('msg') as MessageId,
        space: conversation.space,
        conversation: conversation.id,
        conversationTitle: conversation.title,
        sender: { kind: 'human', displayName: 'you' },
        body: request.body,
        mentions: [],
        attachments: (request.files ?? []).map((file) => ({
          id: fixtures.attachmentId(nextId('att')),
          filename: file.name,
          contentType: file.type === '' ? 'application/octet-stream' : file.type,
          sizeBytes: file.size,
        })),
        sentAt: now(),
      };
      messages.push(message);
      seenIdempotencyKeys.set(request.idempotencyKey, message);
      return { message, conversation };
    },

    async listReads(filter?: ReadLogFilter) {
      await latency();
      requireSession();
      const filtered =
        filter?.agent === undefined ? reads : reads.filter((r) => r.agent.id === filter.agent);
      return page([...filtered].sort((a, b) => b.readAt.localeCompare(a.readAt)));
    },
    async listEscalations() {
      await latency();
      requireSession();
      return page([...escalations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    },
    async search(query: SearchQuery) {
      await latency();
      requireSession();
      const needle = query.q.trim().toLowerCase();
      if (needle === '') return page<SearchResult>([]);
      const results: SearchResult[] = messages
        .filter((m) => m.body.toLowerCase().includes(needle))
        .filter((m) => query.space === undefined || m.space === query.space)
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .map((message) => {
          const at = message.body.toLowerCase().indexOf(needle);
          const from = Math.max(0, at - 60);
          return {
            message,
            spaceName: spaces.find((s) => s.id === message.space)?.name ?? String(message.space),
            snippet:
              (from > 0 ? '…' : '') +
              message.body.slice(from, at + needle.length + 60).replace(/\s+/g, ' ') +
              '…',
          };
        });
      return page(results);
    },

    attachmentHref(id) {
      return `/api/admin/attachments/${encodeURIComponent(id)}`;
    },
  };
}
