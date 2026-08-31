/**
 * What a story needs to stand up: a client that answers out of `fixtures.ts`,
 * and the providers a screen expects to be inside.
 *
 * A story picks its client with `parameters: { api: fixtureApi({ ... }) }`;
 * the decorator below puts it where `useApi` looks. `hangs()` and `fails()`
 * are how a loading or failed state is asked for, since both are states of a
 * promise rather than props.
 */
import type { Decorator } from '@storybook/react-vite';
import { ApiError } from '../api/index.js';
import type {
  AdminAgent,
  AgentId,
  Conversation,
  ConversationId,
  DogparkAdminApi,
  IssuedKey,
  Message,
  MessagePage,
  SpaceId,
} from '../api/index.js';
import type { ErrorCode } from '../../../src/types.js';
import { AppProvider } from '../app/api-context.js';
import { ToastHost } from '../components/Toasts.js';
import * as fixture from './fixtures.js';

/** A call that never answers: the screen stays in its loading state. */
export const hangs = () => (): Promise<never> => new Promise<never>(() => {});

export const fails = (error: ApiError) => (): Promise<never> => Promise.reject(error);

export function apiError(code: ErrorCode | 'network' | 'unknown', message: string): ApiError {
  const status = code === 'unauthenticated' ? 401 : code === 'not_found' ? 404 : 500;
  return new ApiError({ code, message, status });
}

const issued = (agent: AdminAgent): IssuedKey => ({
  key: `dgp_${agent.id}_2f8c41a90b6e7d35c018a4be92f7c103`,
  keyId: 'kx_0f41c8a2',
  agent: { id: agent.id, displayName: agent.displayName },
});

function page(messages: readonly Message[], id?: ConversationId): MessagePage {
  return {
    messages,
    nextCursor: 'qc_end' as MessagePage['nextCursor'],
    hasMore: false,
    annotations: fixture.conversations.find((conversation) => conversation.id === id)?.annotations,
  };
}

export function fixtureApi(overrides: Partial<DogparkAdminApi> = {}): DogparkAdminApi {
  const first = fixture.agents[0] as AdminAgent;
  const base: DogparkAdminApi = {
    login: () => Promise.resolve({ csrfToken: 'csrf_5e1c', displayName: 'pete' }),
    resume: () => Promise.resolve({ csrfToken: 'csrf_5e1c', displayName: 'pete' }),
    logout: () => Promise.resolve(),

    listSpaces: () => Promise.resolve(fixture.spaces),
    awaitChanges: () => new Promise<string>(() => {}),
    createSpace: (name: string) => Promise.resolve({ id: 'sp_new' as SpaceId, name }),
    renameSpace: () => Promise.resolve(),
    setSpaceDescription: () => Promise.resolve(),
    listMembers: () => Promise.resolve(fixture.members),
    addMember: () => Promise.resolve(),
    removeMember: () => Promise.resolve(),

    listAgents: () => Promise.resolve(fixture.agents),
    createAgent: (name: string) =>
      Promise.resolve({ ...issued(first), agent: { id: 'ag_new' as AgentId, displayName: name } }),
    renameAgent: () => Promise.resolve(),
    setAgentDescription: () => Promise.resolve(),
    setMembershipNote: () => Promise.resolve(),
    issueKey: () => Promise.resolve(issued(first)),
    revokeKey: () => Promise.resolve(),
    archiveAgent: () => Promise.resolve(),
    unarchiveAgent: () => Promise.resolve(issued(first)),

    listConversations: (space: SpaceId) =>
      Promise.resolve(space === fixture.delivery.id ? fixture.conversations : []),
    readConversation: (id: ConversationId, query) => {
      const messages = fixture.messagesByConversation.get(id) ?? [];
      return Promise.resolve(
        page(query?.order === 'newest' ? [...messages].reverse() : messages, id),
      );
    },
    renameConversation: (id: ConversationId, title: string): Promise<Conversation> =>
      Promise.resolve({ id, space: fixture.delivery.id, title }),
    post: () =>
      Promise.resolve({
        message: fixture.wrapUp,
        conversation: fixture.rotation,
        annotations: { status: 'open', pins: [] },
      }),
    completeConversation: () => Promise.resolve({ status: 'complete', pins: [] }),
    reopenConversation: () => Promise.resolve({ status: 'open', pins: [] }),
    pinMessage: (_id, message) =>
      Promise.resolve({ status: 'open', pins: [{ message, actor: fixture.pete }] }),
    unpinConversation: () => Promise.resolve({ status: 'open', pins: [] }),

    listReads: (filter) =>
      Promise.resolve({
        items:
          filter?.agent === undefined
            ? fixture.reads
            : fixture.reads.filter((entry) => entry.agent.id === filter.agent),
        nextCursor: 'qc_r1',
        hasMore: true,
      }),
    getRead: () => Promise.resolve(fixture.conversationRead),
    listEscalations: () =>
      Promise.resolve({
        items: fixture.escalations,
        nextCursor: null,
        hasMore: false,
        unacknowledged: 2,
        undelivered: 2,
        webhookConfigured: true,
      }),
    acknowledgeEscalation: (id) => {
      const found = fixture.escalations.find((each) => each.id === id) ?? fixture.escalations[0];
      if (found === undefined) return Promise.reject(new Error('no escalation'));
      return Promise.resolve({ ...found, acknowledgedAt: found.raisedAt });
    },
    search: () =>
      Promise.resolve({ items: fixture.searchResults, nextCursor: null, hasMore: false }),

    attachmentHref: (id) => `/api/admin/attachments/${id}`,
  };
  return { ...base, ...overrides };
}

/**
 * Every story renders inside the app's own `.content` column, with a client
 * and the toast host the components post failures into.
 */
export const withDogpark: Decorator = (Story, context) => {
  const api = (context.parameters['api'] as DogparkAdminApi | undefined) ?? fixtureApi();
  return (
    <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
      <ToastHost>
        <div className="content" style={{ height: '100%' }}>
          <Story />
        </div>
      </ToastHost>
    </AppProvider>
  );
};
