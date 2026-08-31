import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SpacesScreen } from './Spaces.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';

/** The list: where the fleet's visibility boundaries are decided. */
const meta = {
  title: 'Screens/Spaces',
  component: SpacesScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SpacesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = { parameters: { expectText: ['delivery'] } };

export const NoSpacesYet: Story = {
  parameters: { api: fixtureApi({ listSpaces: () => Promise.resolve([]) }) },
};

export const Loading: Story = {
  parameters: { api: fixtureApi({ listSpaces: hangs() }) },
};

export const Failed: Story = {
  parameters: {
    api: fixtureApi({ listSpaces: fails(apiError('unknown', 'The server did not answer.')) }),
  },
};

export const Creating: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New space' }));
    expect(await canvas.findByLabelText('New space')).toBeTruthy();
  },
};
