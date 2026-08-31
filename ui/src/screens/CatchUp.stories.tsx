import type { Meta, StoryObj } from '@storybook/react-vite';
import { CatchUpScreen } from './CatchUp.js';
import { fixtureApi } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

const meta = {
  title: 'Screens/Catch up',
  component: CatchUpScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CatchUpScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithUnreadWork: Story = {
  parameters: { expectText: [fixture.rotation.title, 'complete, 2 new', '📌'] },
};

export const CaughtUp: Story = {
  parameters: {
    expectText: ["You're caught up."],
    api: fixtureApi({
      listCatchUp: () => Promise.resolve({ conversations: [], nextCursor: null, hasMore: false }),
      listEscalations: () =>
        Promise.resolve({
          items: [],
          nextCursor: null,
          hasMore: false,
          unacknowledged: 0,
          undelivered: 0,
          webhookConfigured: false,
        }),
    }),
  },
};

export const EscalationsFirst: Story = {
  parameters: { expectText: ['2 unacknowledged escalations', 'Review escalations'] },
};
