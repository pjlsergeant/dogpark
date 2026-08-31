import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReadLogScreen } from './ReadLog.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/**
 * What each agent asked for, and how much came back. The screen exists to
 * answer "had this agent seen the instruction when it acted?".
 */
const meta = {
  title: 'Screens/ReadLog',
  component: ReadLogScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReadLogScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EveryAgent: Story = {};

/** One agent, which is how a question about one agent is actually asked. */
export const OneAgent: Story = {
  args: { agent: fixture.dp2.id },
};

/** An agent that only writes never appears here, which is normal. */
export const NothingRecorded: Story = {
  args: { agent: fixture.dp1.id },
  parameters: {
    api: fixtureApi({
      listReads: () => Promise.resolve({ items: [], nextCursor: null, hasMore: false }),
    }),
  },
};

export const Loading: Story = {
  parameters: { api: fixtureApi({ listReads: hangs() }) },
};

export const Failed: Story = {
  parameters: {
    api: fixtureApi({ listReads: fails(apiError('unknown', 'The read log is unavailable.')) }),
  },
};
