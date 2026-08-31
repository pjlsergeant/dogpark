import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { ExportMenu } from './ExportMenu.js';
import * as fixture from '../stories/fixtures.js';

const meta = {
  title: 'Components/Export menu',
  component: ExportMenu,
  args: { kind: 'conversation', id: fixture.rotation.id },
} satisfies Meta<typeof ExportMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = { parameters: { expectText: ['Export'] } };

export const Open: Story = {
  parameters: { expectText: ['Markdown', 'JSON', 'Bundle (zip)'] },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText('Export'));
  },
};
