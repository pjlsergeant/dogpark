// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ConversationAnnotations } from '../api/index.js';
import { AppProvider } from '../app/api-context.js';
import { ToastHost } from '../components/Toasts.js';
import { fixtureApi } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';
import { ReaderScreen } from './Reader.js';

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
          latestActivitySeq={42}
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
    expect(advanceReadMark).toHaveBeenCalledWith(fixture.rotation.id, 42);
  });

  test('does not advance a mark in an as-of view', async () => {
    const advanceReadMark = vi.fn(() => Promise.resolve());
    renderCatchUpThread({ advanceReadMark }, fixture.conversationRead.id);
    await screen.findAllByText(/Do not touch production/);
    expect(advanceReadMark).not.toHaveBeenCalled();
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
});
