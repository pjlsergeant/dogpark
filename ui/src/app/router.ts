/**
 * Hash routing.
 *
 * The hash, not the path: Dogpark serves the SPA from `/` alongside `/api/*`
 * (docs/http-api.md) and says nothing about a history fallback, so a deep
 * link under a path would 404 on reload. Every screen is linkable, because
 * the reader and the read log are things you send yourself later.
 */
import { useSyncExternalStore } from 'react';
import type { AgentId, ConversationId, MessageId, SearchOrder, SpaceId } from '../api/index.js';

export type Route =
  | { readonly name: 'spaces' }
  | { readonly name: 'space'; readonly space: SpaceId }
  | { readonly name: 'agents'; readonly agent?: AgentId | undefined }
  | {
      readonly name: 'read';
      readonly space?: SpaceId | undefined;
      readonly conversation?: ConversationId | undefined;
      readonly message?: MessageId | undefined;
      /** A read-log row id: the reader shows the thread as it read then. */
      readonly asOf?: string | undefined;
    }
  | { readonly name: 'reads'; readonly agent?: AgentId | undefined }
  | { readonly name: 'escalations' }
  | {
      readonly name: 'search';
      readonly q: string;
      readonly space?: SpaceId | undefined;
      readonly order?: SearchOrder | undefined;
    };

function subscribe(callback: () => void): () => void {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

const currentHash = (): string => window.location.hash;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash, currentHash);
  return parseRoute(hash);
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter((s) => s !== '');
  const query = new URLSearchParams(queryPart);
  const [head, first, second] = segments;

  switch (head) {
    case 'space':
      return first === undefined
        ? { name: 'spaces' }
        : { name: 'space', space: decodeURIComponent(first) as SpaceId };
    case 'agents':
      return {
        name: 'agents',
        agent: first === undefined ? undefined : (decodeURIComponent(first) as AgentId),
      };
    case 'read':
      return {
        name: 'read',
        space: first === undefined ? undefined : (decodeURIComponent(first) as SpaceId),
        conversation:
          second === undefined ? undefined : (decodeURIComponent(second) as ConversationId),
        message: query.get('m') === null ? undefined : (query.get('m') as MessageId),
        asOf: query.get('asOf') ?? undefined,
      };
    case 'reads': {
      const agent = query.get('agent');
      return { name: 'reads', agent: agent === null ? undefined : (agent as AgentId) };
    }
    case 'escalations':
      return { name: 'escalations' };
    case 'search': {
      const space = query.get('space');
      const order = query.get('order');
      return {
        name: 'search',
        q: query.get('q') ?? '',
        space: space === null ? undefined : (space as SpaceId),
        order: order === 'newest' ? 'newest' : undefined,
      };
    }
    case 'spaces':
    default:
      return { name: 'spaces' };
  }
}

export const href = {
  spaces: (): string => '#/spaces',
  space: (id: SpaceId): string => `#/space/${encodeURIComponent(id)}`,
  agents: (id?: AgentId): string =>
    id === undefined ? '#/agents' : `#/agents/${encodeURIComponent(id)}`,
  read: (
    space?: SpaceId,
    conversation?: ConversationId,
    message?: MessageId,
    asOf?: string,
  ): string => {
    let path = '#/read';
    if (space !== undefined) path += `/${encodeURIComponent(space)}`;
    if (space !== undefined && conversation !== undefined) {
      path += `/${encodeURIComponent(conversation)}`;
    }
    const params = new URLSearchParams();
    if (message !== undefined) params.set('m', message);
    if (asOf !== undefined) params.set('asOf', asOf);
    const query = params.toString();
    return query === '' ? path : `${path}?${query}`;
  },
  reads: (agent?: AgentId): string =>
    agent === undefined ? '#/reads' : `#/reads?agent=${encodeURIComponent(agent)}`,
  escalations: (): string => '#/escalations',
  search: (q: string, space?: SpaceId, order?: SearchOrder): string => {
    const params = new URLSearchParams({ q });
    if (space !== undefined) params.set('space', space);
    if (order === 'newest') params.set('order', order);
    return `#/search?${params.toString()}`;
  },
};

export function navigate(target: string): void {
  window.location.hash = target.startsWith('#') ? target.slice(1) : target;
}
