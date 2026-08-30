/**
 * The real admin client. One module; nothing else in the app fetches.
 *
 * Session is an `HttpOnly` cookie the app never touches. The CSRF token
 * minted alongside it is held here, in memory, and sent as `X-CSRF-Token` on
 * every state-changing request (docs/http-api.md).
 */
import type { DogparkAdminApi } from './api.js';
import type {
  AdminAgent,
  AttachmentId,
  ConversationSummary,
  Escalation,
  HumanPostRequest,
  HumanPostResult,
  IssuedKey,
  Message,
  MessagesPage,
  Page,
  ReadLogEntry,
  ReadLogFilter,
  SearchQuery,
  SearchResult,
  SessionCredentials,
  Space,
  SpaceMembers,
} from './types.js';
import { ApiError } from './types.js';

const BASE = '/api/admin';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  readonly json?: unknown;
  readonly form?: FormData | undefined;
  readonly query?: Readonly<Record<string, string | number | undefined>> | undefined;
  /** Treat these statuses as `null` rather than throwing. */
  readonly softFail?: readonly number[] | undefined;
}

/** Errors are `{ code, message, retryAfterSeconds? }` — anything else is ours. */
function toApiError(status: number, body: unknown, fallback: string): ApiError {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record['code'] === 'string' ? record['code'] : undefined;
    const message = typeof record['message'] === 'string' ? record['message'] : undefined;
    const retry =
      typeof record['retryAfterSeconds'] === 'number' ? record['retryAfterSeconds'] : undefined;
    if (code !== undefined) {
      return new ApiError({
        code: code as ApiError['code'],
        message: message ?? fallback,
        status,
        retryAfterSeconds: retry,
      });
    }
  }
  return new ApiError({
    code: status === 401 ? 'unauthenticated' : 'unknown',
    message: fallback,
    status,
  });
}

/**
 * Servers answering a collection may reasonably send `{ items, nextCursor,
 * hasMore }`, a bare array, or the protocol's own `{ messages, ... }`. The
 * contract does not say which, so the client accepts all three rather than
 * making every screen defensive.
 */
function toPage<T>(raw: unknown, key: string): Page<T> {
  if (Array.isArray(raw)) return { items: raw as T[], nextCursor: null, hasMore: false };
  if (raw !== null && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const items = record['items'] ?? record[key];
    if (Array.isArray(items)) {
      return {
        items: items as T[],
        nextCursor: typeof record['nextCursor'] === 'string' ? record['nextCursor'] : null,
        hasMore: record['hasMore'] === true,
      };
    }
  }
  return { items: [], nextCursor: null, hasMore: false };
}

export function createHttpApi(): DogparkAdminApi {
  let csrfToken: string | null = null;

  async function request(
    method: Method,
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const url = new URL(BASE + path, window.location.origin);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: BodyInit | undefined;
    if (options.form !== undefined) {
      body = options.form;
    } else if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    // Safe methods carry no token; everything else must.
    if (method !== 'GET' && csrfToken !== null) headers['X-CSRF-Token'] = csrfToken;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: 'same-origin',
        redirect: 'error',
      });
    } catch (cause) {
      throw new ApiError({
        code: 'network',
        message: cause instanceof Error ? cause.message : 'The server could not be reached.',
        status: 0,
      });
    }

    if (options.softFail?.includes(response.status) === true) return null;

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      throw toApiError(response.status, parsed, `${method} ${path} failed (${response.status})`);
    }
    return parsed;
  }

  return {
    async login(password) {
      const raw = (await request('POST', '/session', { json: { password } })) as Record<
        string,
        unknown
      > | null;
      const token = raw !== null && typeof raw['csrfToken'] === 'string' ? raw['csrfToken'] : null;
      if (token === null) {
        throw new ApiError({
          code: 'unknown',
          message: 'The server accepted the password but returned no CSRF token.',
          status: 200,
        });
      }
      csrfToken = token;
      return raw as unknown as SessionCredentials;
    },

    /**
     * Not in `docs/http-api.md`. A reload keeps the cookie but loses the
     * token held here, so without this route the human must log in again
     * every refresh. Absence is treated as "no session", never as an error.
     */
    async resume() {
      try {
        const raw = (await request('GET', '/session', { softFail: [401, 403, 404] })) as Record<
          string,
          unknown
        > | null;
        if (raw === null || typeof raw['csrfToken'] !== 'string') return null;
        csrfToken = raw['csrfToken'];
        return raw as unknown as SessionCredentials;
      } catch {
        return null;
      }
    },

    async logout() {
      await request('DELETE', '/session', { softFail: [401] });
      csrfToken = null;
    },

    async listSpaces() {
      return toPage<Space>(await request('GET', '/spaces'), 'spaces').items;
    },
    async createSpace(name) {
      return (await request('POST', '/spaces', { json: { name } })) as Space;
    },
    async renameSpace(id, name) {
      await request('PATCH', `/spaces/${encodeURIComponent(id)}`, { json: { name } });
    },
    async listMembers(id) {
      const raw = (await request('GET', `/spaces/${encodeURIComponent(id)}/members`)) as Record<
        string,
        unknown
      > | null;
      // `{ current, history }` is the pinned shape. A membership entry that
      // arrives as a bare agent rather than `{ agent, grantedAt }` is still
      // rendered, without its dates.
      const entries = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
      const asMembership = (entry: Record<string, unknown>): Record<string, unknown> =>
        'agent' in entry ? entry : { agent: entry, grantedAt: null, revokedAt: null };
      return {
        current: entries(raw?.['current']).map(asMembership),
        history: entries(raw?.['history'] ?? raw?.['intervals']).map(asMembership),
      } as unknown as SpaceMembers;
    },
    async addMember(space, agent) {
      await request(
        'PUT',
        `/spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(agent)}`,
      );
    },
    async removeMember(space, agent) {
      await request(
        'DELETE',
        `/spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(agent)}`,
      );
    },

    async listAgents() {
      // `includeArchived` is the UI's ask; a server that ignores it and
      // returns everything is equally correct as far as this screen goes.
      return toPage<AdminAgent>(
        await request('GET', '/agents', { query: { includeArchived: 'true' } }),
        'agents',
      ).items;
    },
    async createAgent(name) {
      return (await request('POST', '/agents', { json: { name } })) as IssuedKey;
    },
    async renameAgent(id, name) {
      await request('PATCH', `/agents/${encodeURIComponent(id)}`, { json: { name } });
    },
    async issueKey(id, label) {
      return (await request('POST', `/agents/${encodeURIComponent(id)}/keys`, {
        json: label === undefined ? {} : { label },
      })) as IssuedKey;
    },
    async revokeKey(agent, keyId) {
      await request(
        'DELETE',
        `/agents/${encodeURIComponent(agent)}/keys/${encodeURIComponent(keyId)}`,
      );
    },
    async archiveAgent(id) {
      await request('POST', `/agents/${encodeURIComponent(id)}/archive`);
    },
    async unarchiveAgent(id) {
      return (await request('POST', `/agents/${encodeURIComponent(id)}/unarchive`)) as IssuedKey;
    },

    async listConversations(space) {
      return toPage<ConversationSummary>(
        await request('GET', `/spaces/${encodeURIComponent(space)}/conversations`),
        'conversations',
      ).items;
    },
    async readConversation(id, query) {
      const raw = (await request('GET', `/conversations/${encodeURIComponent(id)}/messages`, {
        query: {
          since: query?.since,
          until: query?.until,
          after: query?.after,
        },
      })) as Record<string, unknown> | null;
      const page = toPage<Message>(raw, 'messages');
      return {
        messages: page.items,
        nextCursor: page.nextCursor as MessagesPage['nextCursor'],
        hasMore: page.hasMore,
      };
    },
    async post(request_: HumanPostRequest) {
      const { files, ...rest } = request_;
      if (files !== undefined && files.length > 0) {
        const form = new FormData();
        form.append('request', JSON.stringify(rest));
        for (const file of files) form.append('files', file, file.name);
        return (await request('POST', '/messages', { form })) as HumanPostResult;
      }
      return (await request('POST', '/messages', { json: rest })) as HumanPostResult;
    },

    async listReads(filter?: ReadLogFilter) {
      return toPage<ReadLogEntry>(
        await request('GET', '/reads', {
          query: { agent: filter?.agent, after: filter?.after, limit: filter?.limit },
        }),
        'reads',
      );
    },
    async listEscalations(after?: string) {
      return toPage<Escalation>(
        await request('GET', '/escalations', { query: { after } }),
        'escalations',
      );
    },
    async search(query: SearchQuery) {
      return toPage<SearchResult>(
        await request('GET', '/search', {
          query: { q: query.q, space: query.space, after: query.after },
        }),
        'results',
      );
    },

    attachmentHref(id: AttachmentId) {
      // Under `/api/admin`, because the human authenticates with a session
      // and the only attachment route in the contract is bearer-only.
      return `${BASE}/attachments/${encodeURIComponent(id)}`;
    },
  };
}
