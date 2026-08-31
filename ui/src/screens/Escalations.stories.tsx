import type { Meta, StoryObj } from '@storybook/react-vite';
import { EscalationsScreen } from './Escalations.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/**
 * The inbox. The headline is whether a human has *seen* each escalation — the
 * badge counts the unacknowledged, and each row carries an acknowledge action.
 * Delivery state is a separate axis, shown per-row only when a webhook exists.
 */
const meta = {
  title: 'Screens/Escalations',
  component: EscalationsScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof EscalationsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All three delivery states at once, and the badge counting the unacknowledged. */
export const Inbox: Story = {
  parameters: {
    expectText: ['The rollback SQL in this thread would drop a role that production also uses.'],
  },
};

/**
 * The blessed no-webhook deployment: delivery state is meaningless, so the
 * whole delivery axis is dropped and only the acknowledge flow remains.
 */
export const NoWebhook: Story = {
  parameters: {
    expectText: ['The rollback SQL in this thread would drop a role that production also uses.'],
    api: fixtureApi({
      listEscalations: () =>
        Promise.resolve({
          items: fixture.escalations,
          nextCursor: null,
          hasMore: false,
          unacknowledged: 2,
          undelivered: 3,
          webhookConfigured: false,
        }),
    }),
  },
};

/** Everything was delivered, so there is nothing to chase. */
export const AllDelivered: Story = {
  parameters: {
    expectText: ['The rollback SQL in this thread would drop a role that production also uses.'],
    api: fixtureApi({
      listEscalations: () =>
        Promise.resolve({
          items: fixture.escalations.filter((each) => each.notification.state === 'sent'),
          nextCursor: null,
          hasMore: false,
          unacknowledged: 0,
          undelivered: 0,
          webhookConfigured: true,
        }),
    }),
  },
};

export const Quiet: Story = {
  parameters: {
    expectText: ['Nothing has been escalated.'],
    api: fixtureApi({
      listEscalations: () =>
        Promise.resolve({
          items: [],
          nextCursor: null,
          hasMore: false,
          unacknowledged: 0,
          undelivered: 0,
          webhookConfigured: true,
        }),
    }),
  },
};

/** More than one page of them, which is what a bad week looks like. */
export const Backlog: Story = {
  parameters: {
    expectText: ['The rollback SQL in this thread would drop a role that production also uses.'],
    api: fixtureApi({
      listEscalations: () =>
        Promise.resolve({
          items: fixture.escalations,
          nextCursor: 'qc_e2',
          hasMore: true,
          unacknowledged: 8,
          undelivered: 9,
          webhookConfigured: true,
        }),
    }),
  },
};

export const Loading: Story = {
  parameters: {
    expectText: ['Loading escalations'],
    api: fixtureApi({ listEscalations: hangs() }),
  },
};

export const Failed: Story = {
  parameters: {
    expectText: ['The server did not answer.'],
    api: fixtureApi({ listEscalations: fails(apiError('unknown', 'The server did not answer.')) }),
  },
};
