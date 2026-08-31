import type { Meta, StoryObj } from '@storybook/react-vite';
import { EscalationsScreen } from './Escalations.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/**
 * The inbox. A failed webhook is the case where this screen is the only thing
 * between an agent saying "something is wrong" and nobody hearing it, so the
 * notification state is as prominent as the reason.
 */
const meta = {
  title: 'Screens/Escalations',
  component: EscalationsScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof EscalationsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All three delivery states at once, and the badge counting the undelivered. */
export const Inbox: Story = {
  parameters: {
    expectText: ['The rollback SQL in this thread would drop a role that production also uses.'],
  },
};

/** Everything was delivered, so there is nothing to chase. */
export const AllDelivered: Story = {
  parameters: {
    api: fixtureApi({
      listEscalations: () =>
        Promise.resolve({
          items: fixture.escalations.filter((each) => each.notification.state === 'sent'),
          nextCursor: null,
          hasMore: false,
          undelivered: 0,
        }),
    }),
  },
};

export const Quiet: Story = {
  parameters: {
    api: fixtureApi({
      listEscalations: () =>
        Promise.resolve({ items: [], nextCursor: null, hasMore: false, undelivered: 0 }),
    }),
  },
};

/** More than one page of them, which is what a bad week looks like. */
export const Backlog: Story = {
  parameters: {
    api: fixtureApi({
      listEscalations: () =>
        Promise.resolve({
          items: fixture.escalations,
          nextCursor: 'qc_e2',
          hasMore: true,
          undelivered: 9,
        }),
    }),
  },
};

export const Loading: Story = {
  parameters: { api: fixtureApi({ listEscalations: hangs() }) },
};

export const Failed: Story = {
  parameters: {
    api: fixtureApi({ listEscalations: fails(apiError('unknown', 'The server did not answer.')) }),
  },
};
