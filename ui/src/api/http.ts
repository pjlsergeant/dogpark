/**
 * The real admin client. One module; nothing else in the app fetches.
 *
 * Session is an `HttpOnly` cookie the app never touches. The CSRF token
 * minted alongside it is held here, in memory, and sent as `X-CSRF-Token` on
 * every state-changing request (docs/http-api.md).
 *
 * Responses are decoded through the protocol's own response schemas
 * (`src/types.ts`). In dev the body is `.parse`d — a mismatch fails loudly,
 * close to its cause; in prod the schema is only a type, cast onto the body
 * with no zod on the hot path.
 */
import { z } from 'zod';
import {
  AdminAgentSchema,
  ChangesResponseSchema,
  ConversationSchema,
  ConversationAnnotationsSchema,
  ConversationSummarySchema,
  EscalationSchema,
  EscalationsResponseSchema,
  HumanCatchUpPageSchema,
  IssuedKeySchema,
  MessagePageSchema,
  PostResultSchema,
  ReadLogEntrySchema,
  ReadLogPageSchema,
  SearchResponseSchema,
  SessionCredentialsSchema,
  SpaceSchema,
  SpaceMembersSchema,
  SpaceSummarySchema,
} from '../../../src/types.js';
import type { DogparkAdminApi } from './api.js';
import type { AttachmentId, HumanPostRequest, Page, ReadLogEntry, SearchQuery } from './types.js';
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

/**
 * The decode policy in one place: parse in dev, cast in prod. The schema is the
 * type's source either way, so a route that threads the wrong one is a compile
 * error whether or not zod runs.
 */
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  return import.meta.env.DEV ? schema.parse(value) : (value as T);
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

/** A `{ <key>, nextCursor, hasMore }` envelope collapses to one generic page. */
function pageOf<T>(
  envelope: { readonly nextCursor: string | null; readonly hasMore: boolean },
  items: readonly T[],
): Page<T> {
  return { items, nextCursor: envelope.nextCursor, hasMore: envelope.hasMore };
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
      const raw = await request('POST', '/session', { json: { password } });
      const record = (raw ?? {}) as Record<string, unknown>;
      if (typeof record['csrfToken'] !== 'string') {
        throw new ApiError({
          code: 'unknown',
          message: 'The server accepted the password but returned no CSRF token.',
          status: 200,
        });
      }
      csrfToken = record['csrfToken'];
      return decode(SessionCredentialsSchema, raw);
    },

    /**
     * A reload keeps the cookie but loses the token held here. A 401 means the
     * session is gone, which is "not signed in" rather than an error.
     */
    async resume() {
      try {
        const raw = await request('GET', '/session', { softFail: [401] });
        const record = raw as Record<string, unknown> | null;
        if (record === null || typeof record['csrfToken'] !== 'string') return null;
        csrfToken = record['csrfToken'];
        return decode(SessionCredentialsSchema, raw);
      } catch {
        return null;
      }
    },

    async logout() {
      await request('DELETE', '/session', { softFail: [401] });
      csrfToken = null;
    },

    async listSpaces() {
      return decode(z.array(SpaceSummarySchema), await request('GET', '/spaces'));
    },
    async awaitChanges(after, waitSeconds, signal) {
      const raw = decode(
        ChangesResponseSchema,
        await request('GET', '/changes', { query: { after, waitSeconds }, signal }),
      );
      return raw.version;
    },
    async createSpace(name) {
      return decode(SpaceSchema, await request('POST', '/spaces', { json: { name } }));
    },
    async renameSpace(id, name) {
      await request('PATCH', `/spaces/${encodeURIComponent(id)}`, { json: { name } });
    },
    async setSpaceDescription(id, description) {
      await request('PUT', `/spaces/${encodeURIComponent(id)}/description`, {
        json: { description },
      });
    },
    async listMembers(id) {
      return decode(
        SpaceMembersSchema,
        await request('GET', `/spaces/${encodeURIComponent(id)}/members`),
      );
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
      return decode(z.array(AdminAgentSchema), await request('GET', '/agents'));
    },
    async createAgent(name) {
      return decode(IssuedKeySchema, await request('POST', '/agents', { json: { name } }));
    },
    async renameAgent(id, name) {
      await request('PATCH', `/agents/${encodeURIComponent(id)}`, { json: { name } });
    },
    async setAgentDescription(id, description) {
      await request('PUT', `/agents/${encodeURIComponent(id)}/description`, {
        json: { description },
      });
    },
    async setMembershipNote(space, agent, description) {
      await request(
        'PUT',
        `/spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(agent)}/note`,
        { json: { description } },
      );
    },
    async issueKey(id, label) {
      return decode(
        IssuedKeySchema,
        await request('POST', `/agents/${encodeURIComponent(id)}/keys`, {
          json: label === undefined ? {} : { label },
        }),
      );
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
      return decode(
        IssuedKeySchema,
        await request('POST', `/agents/${encodeURIComponent(id)}/unarchive`),
      );
    },

    async listConversations(space) {
      return decode(
        z.array(ConversationSummarySchema),
        await request('GET', `/spaces/${encodeURIComponent(space)}/conversations`),
      );
    },
    async listCatchUp(after) {
      return decode(
        HumanCatchUpPageSchema,
        await request('GET', '/catch-up', { query: { after } }),
      );
    },
    async advanceReadMark(conversation, seq) {
      await request('POST', '/read-mark', { json: { conversation, seq } });
    },
    async renameConversation(id, title) {
      return decode(
        ConversationSchema,
        await request('PATCH', `/conversations/${encodeURIComponent(id)}`, { json: { title } }),
      );
    },
    async readConversation(id, query) {
      const path =
        query?.asOf === undefined
          ? `/conversations/${encodeURIComponent(id)}/messages`
          : `/reads/${encodeURIComponent(query.asOf)}/conversations/${encodeURIComponent(id)}/messages`;
      return decode(
        MessagePageSchema,
        await request('GET', path, { query: { after: query?.after, order: query?.order } }),
      );
    },
    async post(request_: HumanPostRequest) {
      const { files, ...rest } = request_;
      if (files !== undefined && files.length > 0) {
        const form = new FormData();
        form.append('request', JSON.stringify(rest));
        for (const file of files) form.append('files', file, file.name);
        return decode(PostResultSchema, await request('POST', '/messages', { form }));
      }
      return decode(PostResultSchema, await request('POST', '/messages', { json: rest }));
    },
    async completeConversation(id) {
      return decode(
        ConversationAnnotationsSchema,
        await request('POST', `/conversations/${encodeURIComponent(id)}/complete`, { json: {} }),
      );
    },
    async reopenConversation(id) {
      return decode(
        ConversationAnnotationsSchema,
        await request('POST', `/conversations/${encodeURIComponent(id)}/reopen`, { json: {} }),
      );
    },
    async pinMessage(id, message) {
      return decode(
        ConversationAnnotationsSchema,
        await request('POST', `/conversations/${encodeURIComponent(id)}/pin`, {
          json: { messageId: message },
        }),
      );
    },
    async unpinConversation(id) {
      return decode(
        ConversationAnnotationsSchema,
        await request('POST', `/conversations/${encodeURIComponent(id)}/unpin`, { json: {} }),
      );
    },

    async listReads(filter) {
      const raw = decode(
        ReadLogPageSchema,
        await request('GET', '/reads', {
          query: { agent: filter?.agent, after: filter?.after, limit: filter?.limit },
        }),
      );
      return pageOf<ReadLogEntry>(raw, raw.reads);
    },
    async getRead(id: string) {
      return decode(ReadLogEntrySchema, await request('GET', `/reads/${encodeURIComponent(id)}`));
    },
    async listEscalations(filter) {
      const raw = decode(
        EscalationsResponseSchema,
        await request('GET', '/escalations', {
          query: { order: filter?.order, after: filter?.after, limit: filter?.limit },
        }),
      );
      return {
        ...pageOf(raw, raw.escalations),
        unacknowledged: raw.unacknowledged,
        undelivered: raw.undelivered,
        webhookConfigured: raw.webhookConfigured,
      };
    },
    async acknowledgeEscalation(id) {
      return decode(
        EscalationSchema,
        await request('POST', `/escalations/${encodeURIComponent(id)}/ack`),
      );
    },
    async search(query: SearchQuery) {
      const raw = decode(
        SearchResponseSchema,
        await request('GET', '/search', {
          query: { q: query.q, space: query.space, order: query.order, after: query.after },
        }),
      );
      return pageOf(raw, raw.results);
    },

    attachmentHref(id: AttachmentId) {
      return `${BASE}/attachments/${encodeURIComponent(id)}`;
    },
    exportUrl(kind, id, format) {
      const collection = kind === 'conversation' ? 'conversations' : 'spaces';
      return `${BASE}/${collection}/${encodeURIComponent(id)}/export?format=${format}`;
    },
  };
}
