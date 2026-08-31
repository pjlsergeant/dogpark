// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { AppProvider } from '../app/api-context.js';
import { fixtureApi } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';
import { CatchUpScreen } from './CatchUp.js';

afterEach(cleanup);

test('renders unread threads including complete-but-new work', async () => {
  const api = fixtureApi();
  render(
    <AppProvider
      value={{ api, session: { displayName: 'pete', examplePassword: false }, logout: () => {} }}
    >
      <CatchUpScreen />
    </AppProvider>,
  );

  expect(await screen.findByText(fixture.backups.title)).toBeTruthy();
  expect(screen.getByText('complete, 2 new')).toBeTruthy();
});
