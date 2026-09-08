// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AppProvider } from '../app/api-context.js';
import { fixtureApi } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';
import { CatchUpScreen } from './CatchUp.js';

afterEach(cleanup);

test('renders unread threads including complete-but-new work', async () => {
  const api = fixtureApi();
  render(
    <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
      <CatchUpScreen />
    </AppProvider>,
  );

  expect(await screen.findByText(fixture.backups.title)).toBeTruthy();
  expect(screen.getByText('complete, 2 new')).toBeTruthy();
});

test('marks all rendered conversations read through the newest row', async () => {
  const markAllRead = vi.fn(async (_through: number) => {});
  let caughtUp = false;
  const api = fixtureApi({
    listCatchUp: async () =>
      caughtUp ? { ...fixture.catchUp, conversations: [] } : fixture.catchUp,
    markAllRead: async (through) => {
      caughtUp = true;
      await markAllRead(through);
    },
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(
    <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
      <CatchUpScreen />
    </AppProvider>,
  );

  await screen.findByText(fixture.backups.title);
  await userEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
  expect(markAllRead).toHaveBeenCalledWith(fixture.catchUp.conversations[0]!.latestActivitySeq);
  expect(await screen.findByText("You're caught up.")).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
});
