import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AgentsScreen } from './Agents.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/**
 * The roles, their keys, and the one moment a key is readable. The failure
 * count is attempts *claiming* an id, so it is loud only while the agent has
 * never authenticated — which is the window where it diagnoses anything.
 */
const meta = {
  title: 'Screens/Agents',
  component: AgentsScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AgentsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Roster: Story = {};

/** One open: its facts, every key it has ever had, and what can be done to it. */
export const Managing: Story = {
  args: { selected: fixture.dp1.id },
};

/** Never authenticated, and something has been trying its id. */
export const Unproven: Story = {
  args: { selected: fixture.dp4.id },
};

export const NoAgentsYet: Story = {
  parameters: { api: fixtureApi({ listAgents: () => Promise.resolve([]) }) },
};

export const Loading: Story = {
  parameters: { api: fixtureApi({ listAgents: hangs() }) },
};

export const Failed: Story = {
  parameters: {
    api: fixtureApi({ listAgents: fails(apiError('unauthenticated', 'Session expired.')) }),
  },
};

/** Archived roles are hidden until asked for; the history is kept either way. */
export const ShowingArchived: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText(/Show archived/));
    expect(canvas.getByText('dp0')).toBeTruthy();
  },
};

/** The reveal: deliberately hard to dismiss without reading. */
export const KeyRevealed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New agent' }));
    await userEvent.type(await canvas.findByLabelText('Name'), 'dp5');
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }));
    expect(await canvas.findByText('The key')).toBeTruthy();
  },
};
