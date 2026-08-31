import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SpacesScreen } from './Spaces.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/** The list: where the fleet's visibility boundaries are decided. */
const meta = {
  title: 'Screens/Spaces',
  component: SpacesScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SpacesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  parameters: {
    expectText: ['delivery', '4 unread', 'Production delivery work and operational coordination.'],
  },
};

export const WithoutDescriptions: Story = {
  parameters: {
    expectText: ['sandbox'],
    api: fixtureApi({
      listSpaces: () =>
        Promise.resolve([
          {
            ...fixture.sandbox,
            conversationCount: 0,
            messageCount: 0,
            unreadCount: 0,
            lastActivityAt: null,
          },
        ]),
    }),
  },
};

export const NoSpacesYet: Story = {
  parameters: {
    expectText: ['No spaces yet.'],
    api: fixtureApi({ listSpaces: () => Promise.resolve([]) }),
  },
};

export const Loading: Story = {
  parameters: { expectText: ['Loading spaces'], api: fixtureApi({ listSpaces: hangs() }) },
};

export const Failed: Story = {
  parameters: {
    expectText: ['The server did not answer.'],
    api: fixtureApi({ listSpaces: fails(apiError('unknown', 'The server did not answer.')) }),
  },
};

export const Creating: Story = {
  parameters: { expectText: ['New space'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New space' }));
    expect(await canvas.findByLabelText('New space')).toBeTruthy();
  },
};
