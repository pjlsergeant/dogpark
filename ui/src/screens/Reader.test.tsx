// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ConversationAnnotations, MessageId, MessagePage } from '../api/index.js';
import { AppProvider } from '../app/api-context.js';
import { ChangesProvider } from '../app/changes.js';
import { ToastHost } from '../components/Toasts.js';
import { fixtureApi } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';
import { ReaderScreen } from './Reader.js';

/** A thread that reads as complete — consistent with a post answering complete. */
const completeThread = (): MessagePage => ({
  messages: [...fixture.rotationMessages].reverse(),
  nextCursor: 'qc_end' as MessagePage['nextCursor'],
  hasMore: false,
  annotations: { status: 'complete', pins: [] },
});

/** Only for its type: the shape a post resolves with. */
const fixturePost = fixtureApi().post;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

function renderReader(overrides = {}) {
  const api = fixtureApi(overrides);
  render(
    <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
      <ToastHost>
        <ReaderScreen space={fixture.delivery.id} conversation={fixture.rotation.id} />
      </ToastHost>
    </AppProvider>,
  );
}

function renderCatchUpThread(overrides = {}, asOf?: string) {
  const api = fixtureApi(overrides);
  render(
    <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
      <ToastHost>
        <ReaderScreen
          space={fixture.delivery.id}
          conversation={fixture.rotation.id}
          unreadCount={3}
          asOf={asOf}
        />
      </ToastHost>
    </AppProvider>,
  );
}

describe('Reader catch-up marks', () => {
  test('marks the displayed tip once and highlights the first unread message', async () => {
    const advanceReadMark = vi.fn(() => Promise.resolve());
    renderCatchUpThread({ advanceReadMark });

    const firstUnread = (await screen.findAllByText(/Do not touch production/)).find(
      (node) => node.closest('article') !== null,
    )!;
    expect(firstUnread.closest('article')?.className).toContain('highlight');
    await waitFor(() => expect(advanceReadMark).toHaveBeenCalledTimes(1));
    expect(advanceReadMark).toHaveBeenCalledWith(
      fixture.rotation.id,
      fixture.rotationMessages.at(-1)!.id,
    );
  });

  test('marks the newest displayed message on an ordinary thread view too', async () => {
    const advanceReadMark = vi.fn(() => Promise.resolve());
    renderReader({ advanceReadMark });
    await screen.findAllByText(/Do not touch production/);
    await waitFor(() => expect(advanceReadMark).toHaveBeenCalledTimes(1));
    expect(advanceReadMark).toHaveBeenCalledWith(
      fixture.rotation.id,
      fixture.rotationMessages.at(-1)!.id,
    );
  });

  test('a failed mark is asked again on the next full load', async () => {
    const advanceReadMark = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('mark did not land'))
      .mockResolvedValue(undefined);
    renderReader({ advanceReadMark });
    await screen.findByText(/mark did not land/);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(advanceReadMark).toHaveBeenCalledTimes(2));
  });

  test("an older mark's failure does not forget a newer mark already sent", async () => {
    const older = [...fixture.rotationMessages].reverse();
    const arrived = { ...fixture.wrapUp, id: 'm_arrived' as MessageId, body: 'Just arrived.' };
    const page = (messages: typeof older): MessagePage => ({
      messages,
      nextCursor: 'qc_end' as MessagePage['nextCursor'],
      hasMore: false,
      annotations: { status: 'open', pins: [] },
    });
    const marks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
    let reads = 0;
    let changes = 0;
    const advanceReadMark = vi.fn(
      (_conversation: string, message: MessageId) =>
        new Promise<void>((resolve, reject) => {
          marks.set(message, { resolve, reject });
        }),
    );
    const api = fixtureApi({
      // Load, then the poll brings one more message, then Refresh reloads.
      readConversation: () =>
        Promise.resolve((reads += 1) >= 2 ? page([arrived, ...older]) : page(older)),
      advanceReadMark,
      awaitChanges: () => {
        changes += 1;
        return changes === 1 ? Promise.resolve('v1') : new Promise<string>(() => {});
      },
    });
    render(
      <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
        <ChangesProvider api={api}>
          <ToastHost>
            <ReaderScreen space={fixture.delivery.id} conversation={fixture.rotation.id} />
          </ToastHost>
        </ChangesProvider>
      </AppProvider>,
    );
    const newestBefore = older[0]!.id;
    await waitFor(() => expect(marks.has(newestBefore)).toBe(true));
    await waitFor(() => expect(marks.has(arrived.id)).toBe(true));

    // The newer mark lands; then the older one fails.
    await act(async () => {
      marks.get(arrived.id)!.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      marks.get(newestBefore)!.reject(new Error('older mark failed'));
      await Promise.resolve();
    });
    await screen.findByText(/older mark failed/);

    // A full load must not mark the newest message a second time.
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(reads).toBe(3));
    await act(async () => {
      await Promise.resolve();
    });
    expect(advanceReadMark).toHaveBeenCalledTimes(2);
  });

  test('does not advance a mark in an as-of view', async () => {
    const advanceReadMark = vi.fn(() => Promise.resolve());
    renderCatchUpThread({ advanceReadMark }, fixture.conversationRead.id);
    await screen.findAllByText(/Do not touch production/);
    expect(advanceReadMark).not.toHaveBeenCalled();
  });
});

describe('Reader poll ordering', () => {
  test('a poll that began before an action cannot revert what the action returned', async () => {
    const open: MessagePage = {
      messages: [...fixture.rotationMessages].reverse(),
      nextCursor: 'qc_end' as MessagePage['nextCursor'],
      hasMore: false,
      annotations: { status: 'open', pins: [] },
    };
    let resolvePoll: ((page: MessagePage) => void) | undefined;
    let reads = 0;
    let changes = 0;
    const api = fixtureApi({
      readConversation: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(open)
          : new Promise<MessagePage>((resolve) => {
              resolvePoll = resolve;
            });
      },
      completeConversation: vi.fn(() =>
        Promise.resolve({ status: 'complete' as const, pins: [] as const }),
      ),
      // One change wakes the poll; then the long poll hangs like the real one.
      awaitChanges: () => {
        changes += 1;
        return changes === 1 ? Promise.resolve('v1') : new Promise<string>(() => {});
      },
    });
    render(
      <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
        <ChangesProvider api={api}>
          <ToastHost>
            <ReaderScreen space={fixture.delivery.id} conversation={fixture.rotation.id} />
          </ToastHost>
        </ChangesProvider>
      </AppProvider>,
    );
    await waitFor(() => expect(reads).toBe(2));
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(api.completeConversation).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Reopen' });

    // The stale poll lands after the action: the thread stays complete.
    await act(async () => {
      resolvePoll?.(open);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy();
  });
});

describe('Reader poll on an empty thread', () => {
  test('the first messages to arrive are appended rather than mistaken for a gap', async () => {
    const empty: MessagePage = {
      messages: [],
      nextCursor: 'qc_end' as MessagePage['nextCursor'],
      hasMore: false,
      annotations: { status: 'open', pins: [] },
    };
    // The page that arrives is a full one with history behind it.
    const full: MessagePage = {
      ...empty,
      messages: [...fixture.rotationMessages].reverse(),
      nextCursor: 'qc_older' as MessagePage['nextCursor'],
      hasMore: true,
    };
    let reads = 0;
    let changes = 0;
    const api = fixtureApi({
      readConversation: () => Promise.resolve((reads += 1) === 1 ? empty : full),
      awaitChanges: () => {
        changes += 1;
        return changes === 1 ? Promise.resolve('v1') : new Promise<string>(() => {});
      },
    });
    render(
      <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
        <ChangesProvider api={api}>
          <ToastHost>
            <ReaderScreen space={fixture.delivery.id} conversation={fixture.rotation.id} />
          </ToastHost>
        </ChangesProvider>
      </AppProvider>,
    );
    await waitFor(() => expect(reads).toBe(2));
    await screen.findAllByText(/Checks green/);
    expect(screen.getByRole('button', { name: 'Load older messages' })).toBeTruthy();
  });
});

describe('Reader action ordering', () => {
  test('two pins go to the server one at a time, in click order, and the second wins', async () => {
    const pete = fixture.pete;
    const pending = new Map<string, (annotations: ConversationAnnotations) => void>();
    const api = fixtureApi({
      pinMessage: (_conversation: string, message: string) =>
        new Promise<ConversationAnnotations>((resolve) => {
          pending.set(message, resolve);
        }),
    });
    render(
      <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
        <ToastHost>
          <ReaderScreen space={fixture.delivery.id} conversation={fixture.rotation.id} />
        </ToastHost>
      </AppProvider>,
    );
    const inArticle = (nodes: readonly HTMLElement[]): HTMLElement =>
      nodes.find((node) => node.closest('article') !== null)!.closest('article')!;
    const first = inArticle(await screen.findAllByText(/Nothing of mine in that window/));
    const second = inArticle(screen.getAllByText(/Checks green/));
    const firstId = first.id.replace(/^m-/, '') as MessageId;
    const secondId = second.id.replace(/^m-/, '') as MessageId;
    await userEvent.click(within(first).getByRole('button', { name: 'Pin' }));
    await userEvent.click(within(second).getByRole('button', { name: 'Pin' }));
    // Only the first request is out; the second waits for its answer.
    await waitFor(() => expect(pending.has(firstId)).toBe(true));
    expect(pending.has(secondId)).toBe(false);

    await act(async () => {
      pending.get(firstId)!({ status: 'open', pins: [{ message: firstId, actor: pete }] });
      await Promise.resolve();
    });
    await waitFor(() => expect(pending.has(secondId)).toBe(true));
    await act(async () => {
      pending.get(secondId)!({ status: 'open', pins: [{ message: secondId, actor: pete }] });
      await Promise.resolve();
    });
    expect(second.textContent).toContain('pinned by you');
    expect(first.textContent).not.toContain('pinned by you');
  });
});

describe('Reader composer ordering', () => {
  test('a standalone pin waits behind an in-flight post, so the later click is the final state', async () => {
    const pete = fixture.pete;
    const page: MessagePage = {
      messages: [...fixture.rotationMessages].reverse(),
      nextCursor: 'qc_end' as MessagePage['nextCursor'],
      hasMore: false,
    };
    let resolvePost: ((result: Awaited<ReturnType<typeof api.post>>) => void) | undefined;
    const api = fixtureApi({
      readConversation: () => Promise.resolve(page),
      post: () =>
        new Promise<Awaited<ReturnType<typeof api.post>>>((resolve) => {
          resolvePost = resolve;
        }),
      pinMessage: vi.fn((_conversation: string, message: MessageId) =>
        Promise.resolve({ status: 'open' as const, pins: [{ message, actor: pete }] }),
      ),
    });
    render(
      <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
        <ToastHost>
          <ReaderScreen space={fixture.delivery.id} conversation={fixture.rotation.id} />
        </ToastHost>
      </AppProvider>,
    );
    const inArticle = (nodes: readonly HTMLElement[]): HTMLElement =>
      nodes.find((node) => node.closest('article') !== null)!.closest('article')!;
    const target = inArticle(await screen.findAllByText(/Checks green/));

    await userEvent.type(screen.getByLabelText('Message'), 'wrapping up');
    await userEvent.click(screen.getByLabelText('pin this message'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(resolvePost).toBeDefined());
    await userEvent.click(within(target).getByRole('button', { name: 'Pin' }));
    // The pin is queued behind the post, not raced against it.
    expect(api.pinMessage).not.toHaveBeenCalled();

    await act(async () => {
      resolvePost!({
        message: fixture.wrapUp,
        conversation: fixture.rotation,
        annotations: { status: 'open', pins: [{ message: fixture.fromPete.id, actor: pete }] },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(api.pinMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(target.textContent).toContain('pinned by you'));
  });
});

describe('Reader annotations', () => {
  test('complete and reopen update the status immediately', async () => {
    let annotations: ConversationAnnotations = { status: 'open', pins: [] };
    renderReader({
      readConversation: async () => ({
        messages: [...fixture.rotationMessages].reverse(),
        nextCursor: null,
        hasMore: false,
        annotations,
      }),
      completeConversation: async () => (annotations = { ...annotations, status: 'complete' }),
      reopenConversation: async () => (annotations = { ...annotations, status: 'open' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    expect(
      screen.getByRole('heading', { name: fixture.rotation.title }).parentElement?.textContent,
    ).toContain('complete');
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: fixture.rotation.title }).parentElement?.textContent,
      ).not.toContain('complete'),
    );
  });

  test("moving the human pin removes 'you' from the previous message", async () => {
    let annotations: ConversationAnnotations = {
      status: 'open',
      pins: [{ message: fixture.fromPete.id, actor: fixture.pete }],
    };
    renderReader({
      readConversation: async () => ({
        messages: [...fixture.rotationMessages].reverse(),
        nextCursor: null,
        hasMore: false,
        annotations,
      }),
      pinMessage: async (_conversation: string, message: typeof fixture.wrapUp.id) =>
        (annotations = { status: 'open', pins: [{ message, actor: fixture.pete }] }),
    });
    // The pinned summary quotes the message too, so pick the article's copy.
    const inArticle = (nodes: readonly HTMLElement[]): HTMLElement =>
      nodes.find((node) => node.closest('article') !== null)!.closest('article')!;
    const oldMessage = inArticle(await screen.findAllByText(/Do not touch production/));
    expect(oldMessage.textContent).toContain('pinned by you');
    const newMessage = inArticle(screen.getAllByText('Rotation done'));
    await userEvent.click(newMessage.querySelector('button')!);
    await waitFor(() => expect(oldMessage.textContent).not.toContain('pinned by you'));
    expect(newMessage.textContent).toContain('pinned by you');
  });

  test('posting to a complete thread explains that posting did not reopen it', async () => {
    renderReader({
      readConversation: () => Promise.resolve(completeThread()),
      post: async () => ({
        message: fixture.wrapUp,
        conversation: fixture.rotation,
        annotations: { status: 'complete', pins: [] },
      }),
    });
    await userEvent.type(await screen.findByLabelText('Message'), 'One more note');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/new messages do not reopen it/)).toBeTruthy();
  });

  test('flipping a post flag after a failed send retries under a fresh idempotency key', async () => {
    const keys: string[] = [];
    let attempts = 0;
    renderReader({
      post: (request: { idempotencyKey: string }) => {
        keys.push(request.idempotencyKey);
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('lost on the wire'))
          : Promise.resolve({
              message: fixture.wrapUp,
              conversation: fixture.rotation,
              annotations: { status: 'complete' as const, pins: [] as const },
            });
      },
    });
    await userEvent.type(await screen.findByLabelText('Message'), 'Done here');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/lost on the wire/);
    await userEvent.click(screen.getByLabelText('mark complete'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('the draft is not editable while its post is in flight', async () => {
    let resolvePost: ((result: Awaited<ReturnType<typeof fixturePost>>) => void) | undefined;
    renderReader({
      post: () =>
        new Promise<Awaited<ReturnType<typeof fixturePost>>>((resolve) => {
          resolvePost = resolve;
        }),
    });
    const message = (await screen.findByLabelText('Message')) as HTMLTextAreaElement;
    await userEvent.type(message, 'Hold this thought');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(resolvePost).toBeDefined());
    expect(message.disabled).toBe(true);
    expect((screen.getByLabelText('mark complete') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('pin this message') as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      resolvePost!({
        message: fixture.wrapUp,
        conversation: fixture.rotation,
        annotations: { status: 'open', pins: [] },
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(false),
    );
  });

  test('a retried Complete replays under the key of the attempt that failed', async () => {
    const keys: string[] = [];
    let attempts = 0;
    renderReader({
      completeConversation: (_id: string, key: string) => {
        keys.push(key);
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('answer lost'))
          : Promise.resolve({ status: 'complete' as const, pins: [] as const });
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    await screen.findByText(/answer lost/);
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }));
    await screen.findByRole('button', { name: 'Reopen' });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  test('a retained key is retired once newer annotation state has arrived', async () => {
    const keys: string[] = [];
    let completes = 0;
    let changes = 0;
    const page = (status: 'open' | 'complete'): MessagePage => ({
      messages: [...fixture.rotationMessages].reverse(),
      nextCursor: 'qc_end' as MessagePage['nextCursor'],
      hasMore: false,
      annotations: { status, pins: [] },
    });
    let wake: ((version: string) => void) | undefined;
    const api = fixtureApi({
      // Before the failed click the thread reads open; after it, the lost
      // answer's completion did land, and the next poll says so.
      readConversation: () => Promise.resolve(page(completes >= 1 ? 'complete' : 'open')),
      completeConversation: (_id: string, key: string) => {
        keys.push(key);
        completes += 1;
        return completes === 1
          ? Promise.reject(new Error('answer lost'))
          : Promise.resolve({ status: 'complete' as const, pins: [] as const });
      },
      reopenConversation: () => Promise.resolve({ status: 'open' as const, pins: [] as const }),
      // One wake at mount; the second is held until the test releases it.
      awaitChanges: () => {
        changes += 1;
        return changes === 1
          ? Promise.resolve('v1')
          : new Promise<string>((resolve) => {
              if (changes === 2) wake = resolve;
            });
      },
    });
    render(
      <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
        <ChangesProvider api={api}>
          <ToastHost>
            <ReaderScreen space={fixture.delivery.id} conversation={fixture.rotation.id} />
          </ToastHost>
        </ChangesProvider>
      </AppProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    await screen.findByText(/answer lost/);
    // The poll brings the truth: it did complete. Reopen it, then complete again.
    await waitFor(() => expect(wake).toBeDefined());
    await act(async () => {
      wake!('v2');
      await Promise.resolve();
    });
    await screen.findByRole('button', { name: 'Reopen' });
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("a failed attempt's key is not restored when state arrived during the attempt", async () => {
    const keys: string[] = [];
    let changes = 0;
    let wake: ((version: string) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const open: MessagePage = {
      messages: [...fixture.rotationMessages].reverse(),
      nextCursor: 'qc_end' as MessagePage['nextCursor'],
      hasMore: false,
      annotations: { status: 'open', pins: [] },
    };
    const api = fixtureApi({
      readConversation: () => Promise.resolve(open),
      completeConversation: (_id: string, key: string) => {
        keys.push(key);
        return keys.length === 1
          ? new Promise<ConversationAnnotations>((_resolve, reject) => {
              fail = reject;
            })
          : Promise.resolve({ status: 'complete' as const, pins: [] as const });
      },
      awaitChanges: () => {
        changes += 1;
        return changes === 1
          ? Promise.resolve('v1')
          : new Promise<string>((resolve) => {
              if (changes === 2) wake = resolve;
            });
      },
    });
    render(
      <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
        <ChangesProvider api={api}>
          <ToastHost>
            <ReaderScreen space={fixture.delivery.id} conversation={fixture.rotation.id} />
          </ToastHost>
        </ChangesProvider>
      </AppProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(fail).toBeDefined());
    // A poll lands while the attempt is still out, then the attempt fails.
    await waitFor(() => expect(wake).toBeDefined());
    await act(async () => {
      wake!('v2');
      await Promise.resolve();
    });
    await act(async () => {
      fail!(new Error('answer lost'));
      await Promise.resolve();
    });
    await screen.findByText(/answer lost/);
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  test('the completion notice goes when the thread is reopened from the header', async () => {
    renderReader({
      readConversation: () => Promise.resolve(completeThread()),
      post: async () => ({
        message: fixture.wrapUp,
        conversation: fixture.rotation,
        annotations: { status: 'complete', pins: [] },
      }),
      reopenConversation: () => Promise.resolve({ status: 'open' as const, pins: [] as const }),
    });
    await userEvent.type(await screen.findByLabelText('Message'), 'One more note');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/new messages do not reopen it/);
    // The header's Reopen, not the notice's link.
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    await userEvent.click(within(header).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(screen.queryByText(/new messages do not reopen it/)).toBeNull());
  });

  test('a failed inline Reopen is reported, not swallowed', async () => {
    renderReader({
      readConversation: () => Promise.resolve(completeThread()),
      post: async () => ({
        message: fixture.wrapUp,
        conversation: fixture.rotation,
        annotations: { status: 'complete', pins: [] },
      }),
      reopenConversation: () => Promise.reject(new Error('reopen went wrong')),
    });
    await userEvent.type(await screen.findByLabelText('Message'), 'One more note');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const notice = (await screen.findByText(/new messages do not reopen it/)).closest('p')!;
    await userEvent.click(within(notice).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText(/reopen went wrong/)).toBeTruthy();
  });
});
