import { describe, expect, it } from 'vitest';
import type { ConversationId, Message, MessageId, MessagePage } from '../api/index.js';
import { loadFirstUnread, loadThread, olderPage } from './thread-pages.js';
import type { ThreadReader } from './thread-pages.js';

const conversation = 'conv000000000000' as ConversationId;

function message(n: number): Message {
  return {
    kind: 'message',
    seq: n,
    id: `m${n}` as MessageId,
    space: 'space00000000000' as Message['space'],
    conversation,
    conversationTitle: 'long thread',
    sender: { kind: 'human', displayName: 'pete' },
    body: `message ${n}`,
    mentions: [],
    attachments: [],
    sentAt: `2026-08-${String(n).padStart(2, '0')}T00:00:00.000Z` as Message['sentAt'],
  };
}

/** `total` messages, paged newest-first `size` at a time, counting the calls. */
function fakeThread(total: number, size: number): ThreadReader & { calls: number } {
  const all = Array.from({ length: total }, (_, i) => message(i + 1));
  const reader = {
    calls: 0,
    async readConversation(_id: ConversationId, query?: { after?: string | undefined }) {
      reader.calls += 1;
      const end = query?.after === undefined ? total : Number(query.after);
      const start = Math.max(0, end - size);
      const page: MessagePage = {
        messages: all.slice(start, end).reverse(),
        nextCursor: String(start) as MessagePage['nextCursor'],
        hasMore: start > 0,
      };
      return page;
    },
  };
  return reader;
}

const ids = (loaded: { messages: readonly Message[] }): string[] =>
  loaded.messages.map((m) => m.id);

describe('assembling a thread from newest-first pages', () => {
  it('opens on the newest page when nothing is being looked for', async () => {
    const api = fakeThread(9, 3);
    const loaded = await loadThread(api, conversation, undefined);
    expect(ids(loaded)).toEqual(['m7', 'm8', 'm9']);
    expect(loaded.pages).toBe(1);
    expect(loaded.hasMore).toBe(true);
    expect(api.calls).toBe(1);
  });

  it('pages back until the linked message is loaded', async () => {
    const api = fakeThread(9, 3);
    const loaded = await loadThread(api, conversation, 'm2' as MessageId);
    expect(ids(loaded)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(loaded.pages).toBe(3);
    expect(loaded.hasMore).toBe(false);
    expect(api.calls).toBe(3);
  });

  it('stops as soon as the page holding it arrives', async () => {
    const api = fakeThread(9, 3);
    const loaded = await loadThread(api, conversation, 'm5' as MessageId);
    expect(ids(loaded)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(loaded.pages).toBe(2);
  });

  it('opens on the newest page alone when the thread never held it', async () => {
    const api = fakeThread(9, 3);
    const loaded = await loadThread(api, conversation, 'nope' as MessageId);
    // Walked to the beginning looking, then discarded the walk: one page, so
    // the reader is at the live edge and keeps following it.
    expect(api.calls).toBe(3);
    expect(ids(loaded)).toEqual(['m7', 'm8', 'm9']);
    expect(loaded.pages).toBe(1);
    expect(loaded.hasMore).toBe(true);
  });

  it('walks no further than the budget, and shows the newest page if that was not enough', async () => {
    const api = fakeThread(100, 3);
    const loaded = await loadThread(api, conversation, 'm1' as MessageId, undefined, 4);
    expect(api.calls).toBe(4);
    expect(loaded.pages).toBe(1);
    expect(ids(loaded)).toEqual(['m98', 'm99', 'm100']);
  });

  it('prepends one older page on request, and nothing past the beginning', async () => {
    const api = fakeThread(5, 3);
    const first = await loadThread(api, conversation, undefined);
    const more = await olderPage(api, conversation, first);
    expect(ids(more)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(more.hasMore).toBe(false);
    expect(await olderPage(api, conversation, more)).toBe(more);
    expect(api.calls).toBe(2);
  });
});

describe('loadFirstUnread', () => {
  it('counts messages that arrived since the catch-up row on top of its unread count', async () => {
    // Twelve messages, pages of five. The row said three unread as of message
    // ten (its latestActivitySeq); eleven and twelve arrived since. The first
    // unread is message eight, on the second page. By seq, not by clock: two
    // messages in one millisecond are told apart, a timestamp could not.
    const reader = fakeThread(12, 5);
    const { loaded, target, reached } = await loadFirstUnread(
      reader,
      conversation,
      3,
      undefined,
      10,
    );
    expect(target).toBe('m8');
    expect(reached).toBe(true);
    expect(loaded.messages.map((m) => m.id)).toContain('m8');
    // Without the hint, the same count lands late, on message ten.
    expect((await loadFirstUnread(fakeThread(12, 5), conversation, 3)).target).toBe('m10');
  });

  it('says so when the page budget runs out before the first unread', async () => {
    // Sixty single-message pages and sixty unread: the walk stops at the cap
    // with the first unread still beyond it, and must not pretend otherwise.
    const { target, reached } = await loadFirstUnread(fakeThread(60, 1), conversation, 60);
    expect(reached).toBe(false);
    expect(target).toBeUndefined();
  });
});
