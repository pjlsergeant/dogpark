import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SpaceScreen } from './Spaces.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/**
 * One space: who is in it, who used to be, and what is being said. The other
 * half of `Spaces.tsx`.
 */
const meta = {
  title: 'Screens/Space',
  component: SpaceScreen,
  args: { space: fixture.delivery.id },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SpaceScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = { parameters: { expectText: ['dp1'] } };

/** A space nobody is in is a space nothing in it is visible from. */
export const NoMembers: Story = {
  args: { space: fixture.sandbox.id },
  parameters: {
    api: fixtureApi({ listMembers: () => Promise.resolve({ current: [], history: [] }) }),
  },
};

export const Loading: Story = {
  parameters: { api: fixtureApi({ listMembers: hangs(), listConversations: hangs() }) },
};

export const Failed: Story = {
  parameters: {
    api: fixtureApi({ listMembers: fails(apiError('not_found', 'No such space.')) }),
  },
};

/** Membership history is folded away until it is asked for. */
export const PastMembership: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /past membership/ }));
    expect(canvas.getByText('dp0')).toBeTruthy();
  },
};
