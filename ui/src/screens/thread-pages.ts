/**
 * How the reader assembles a thread out of newest-first pages, kept free of
 * React so it can be exercised against a fake API.
 *
 * `order=newest` pages backwards from the end and returns each page
 * newest-first; each page is reversed into reading order and older pages go on
 * the front.
 */
import type {
  ConversationAnnotations,
  ConversationId,
  DogparkAdminApi,
  Message,
  MessageId,
} from '../api/index.js';

export interface Loaded {
  /** Oldest first, as rendered. */
  readonly messages: readonly Message[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** How many pages have been pulled: on one, the reader follows the tip; on more, it stays put. */
  readonly pages: number;
  readonly annotations?: ConversationAnnotations | undefined;
}

export type ThreadReader = Pick<DogparkAdminApi, 'readConversation'>;

/**
 * How far back a deep link walks looking for its message before giving up. A
 * link to a message that is not in the thread — or a thread longer than this
 * — opens on the newest page alone, exactly as a thread opened without a link:
 * the pages walked on the way are discarded, so the reader is in the one-page
 * shape the poll treats as "at the live edge" and keeps following the tip.
 */
export const MAX_PAGES_FOR_TARGET = 50;

/** One page older than `current`, prepended. */
export async function olderPage(
  api: ThreadReader,
  conversation: ConversationId,
  current: Loaded,
  asOf?: string,
): Promise<Loaded> {
  if (current.nextCursor === null || !current.hasMore) return current;
  const page = await api.readConversation(conversation, {
    order: 'newest',
    after: current.nextCursor,
    asOf,
  });
  return {
    messages: [...[...page.messages].reverse(), ...current.messages],
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    pages: current.pages + 1,
    annotations: current.annotations,
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
  asOf?: string,
  maxPages: number = MAX_PAGES_FOR_TARGET,
): Promise<Loaded> {
  const first = await api.readConversation(conversation, { order: 'newest', asOf });
  const newest: Loaded = {
    messages: [...first.messages].reverse(),
    nextCursor: first.nextCursor,
    hasMore: first.hasMore,
    pages: 1,
    annotations: first.annotations,
  };
  if (target === undefined) return newest;
  let loaded = newest;
  const holdsTarget = (): boolean => loaded.messages.some((m) => m.id === target);
  while (
    !holdsTarget() &&
    loaded.hasMore &&
    loaded.nextCursor !== null &&
    loaded.pages < maxPages
  ) {
    loaded = await olderPage(api, conversation, loaded, asOf);
  }
  return holdsTarget() ? loaded : newest;
}

/** Load enough history that the last `unreadCount` messages have a first row. */
export async function loadFirstUnread(
  api: ThreadReader,
  conversation: ConversationId,
  unreadCount: number,
  asOf?: string,
): Promise<{ readonly loaded: Loaded; readonly target: MessageId | undefined }> {
  let loaded = await loadThread(api, conversation, undefined, asOf);
  while (
    loaded.messages.length < unreadCount &&
    loaded.hasMore &&
    loaded.nextCursor !== null &&
    loaded.pages < MAX_PAGES_FOR_TARGET
  ) {
    loaded = await olderPage(api, conversation, loaded, asOf);
  }
  return {
    loaded,
    target: loaded.messages.at(-Math.min(unreadCount, loaded.messages.length))?.id,
  };
}
