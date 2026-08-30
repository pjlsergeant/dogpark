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
  Conversation,
  ConversationSummary,
  Escalation,
  EscalationFilter,
  HumanPostRequest,
  HumanPostResult,
  IssuedKey,
  Message,
  MessagePage,
  Page,
  ReadLogEntry,
  ReadLogFilter,
  SearchQuery,
  SearchResult,
  SessionCredentials,
  Space,
  SpaceSummary,
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
  /** For a request that may be abandoned, such as a long poll on a tab going to the background. */
  readonly signal?: AbortSignal | undefined;
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

/** A `{ <key>, nextCursor, hasMore }` envelope (docs/http-api.md). */
function toPage<T>(raw: unknown, key: string): Page<T> {
  const record = raw as Record<string, unknown>;
  return {
    items: record[key] as T[],
    nextCursor: typeof record['nextCursor'] === 'string' ? record['nextCursor'] : null,
    hasMore: record['hasMore'] === true,
  };
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
        ...(options.signal === undefined ? {} : { signal: options.signal }),
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
     * A reload keeps the cookie but loses the token held here. A 401 means the
     * session is gone, which is "not signed in" rather than an error.
     */
    async resume() {
      try {
        const raw = (await request('GET', '/session', { softFail: [401] })) as Record<
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
      return (await request('GET', '/spaces')) as SpaceSummary[];
    },
    async awaitChanges(after, waitSeconds, signal) {
      const raw = (await request('GET', '/changes', {
        query: { after, waitSeconds },
        signal,
      })) as { version: string };
      return raw.version;
    },
    async createSpace(name) {
      return (await request('POST', '/spaces', { json: { name } })) as Space;
    },
    async renameSpace(id, name) {
      await request('PATCH', `/spaces/${encodeURIComponent(id)}`, { json: { name } });
    },
    async listMembers(id) {
      return (await request(
        'GET',
        `/spaces/${encodeURIComponent(id)}/members`,
      )) as unknown as SpaceMembers;
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
      return (await request('GET', '/agents')) as AdminAgent[];
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
      return (await request(
        'GET',
        `/spaces/${encodeURIComponent(space)}/conversations`,
      )) as ConversationSummary[];
    },
    async renameConversation(id, title) {
      return (await request('PATCH', `/conversations/${encodeURIComponent(id)}`, {
        json: { title },
      })) as Conversation;
    },
    async readConversation(id, query) {
      const path =
        query?.asOf === undefined
          ? `/conversations/${encodeURIComponent(id)}/messages`
          : `/reads/${encodeURIComponent(query.asOf)}/conversations/${encodeURIComponent(id)}/messages`;
      const raw = (await request('GET', path, {
        query: { after: query?.after, order: query?.order },
      })) as Record<string, unknown> | null;
      const page = toPage<Message>(raw, 'messages');
      return {
        messages: page.items,
        nextCursor: page.nextCursor as MessagePage['nextCursor'],
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
    async getRead(id: string) {
      return (await request('GET', `/reads/${encodeURIComponent(id)}`)) as ReadLogEntry;
    },
    async listEscalations(filter?: EscalationFilter) {
      const raw = await request('GET', '/escalations', {
        query: { order: filter?.order, after: filter?.after, limit: filter?.limit },
      });
      return {
        ...toPage<Escalation>(raw, 'escalations'),
        undelivered: (raw as { undelivered: number }).undelivered,
      };
    },
    async search(query: SearchQuery) {
      return toPage<SearchResult>(
        await request('GET', '/search', {
          query: { q: query.q, space: query.space, order: query.order, after: query.after },
        }),
        'results',
      );
    },

    attachmentHref(id: AttachmentId) {
      return `${BASE}/attachments/${encodeURIComponent(id)}`;
    },
  };
}
