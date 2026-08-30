/**
 * How the reader assembles a thread out of newest-first pages, kept free of
 * React so it can be exercised against a fake API.
 *
 * `order=newest` pages backwards from the end and returns each page
 * newest-first; each page is reversed into reading order and older pages go on
 * the front.
 */
import type { ConversationId, DogparkAdminApi, Message, MessageId } from '../api/index.js';

export interface Loaded {
  /** Oldest first, as rendered. */
  readonly messages: readonly Message[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** How many pages have been pulled, so polling knows whether it can reset. */
  readonly pages: number;
}

export type ThreadReader = Pick<DogparkAdminApi, 'readConversation'>;

/**
 * How far back a deep link walks looking for its message before giving up and
 * showing what it has. A link to a message that is not in the thread — or a
 * thread longer than this — opens at the newest page, as it did before.
 */
export const MAX_PAGES_FOR_TARGET = 50;

/** One page older than `current`, prepended. */
export async function olderPage(
  api: ThreadReader,
  conversation: ConversationId,
  current: Loaded,
): Promise<Loaded> {
  if (current.nextCursor === null || !current.hasMore) return current;
  const page = await api.readConversation(conversation, {
    order: 'newest',
    after: current.nextCursor,
  });
  return {
    messages: [...[...page.messages].reverse(), ...current.messages],
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    pages: current.pages + 1,
  };
}

/**
 * The newest page — and, when the reader arrived by a link to one message,
 * every page back to the one holding it. A search result older than the
 * newest page would otherwise open the thread at the bottom with nothing to
 * highlight.
 */
export async function loadThread(
  api: ThreadReader,
  conversation: ConversationId,
  target: MessageId | undefined,
  maxPages: number = MAX_PAGES_FOR_TARGET,
): Promise<Loaded> {
  const first = await api.readConversation(conversation, { order: 'newest' });
  let loaded: Loaded = {
    messages: [...first.messages].reverse(),
    nextCursor: first.nextCursor,
    hasMore: first.hasMore,
    pages: 1,
  };
  if (target === undefined) return loaded;
  const holdsTarget = (): boolean => loaded.messages.some((m) => m.id === target);
  while (
    !holdsTarget() &&
    loaded.hasMore &&
    loaded.nextCursor !== null &&
    loaded.pages < maxPages
  ) {
    loaded = await olderPage(api, conversation, loaded);
  }
  return loaded;
}
