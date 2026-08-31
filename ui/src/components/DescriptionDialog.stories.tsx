import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { DescriptionDialog } from './DescriptionDialog.js';
import * as fixture from '../stories/fixtures.js';

const meta = {
  title: 'Components/DescriptionDialog',
  component: DescriptionDialog,
  args: {
    kind: 'space',
    subjectName: 'delivery',
    spaces: [fixture.delivery],
    onSave: () => Promise.resolve(),
    onClose: () => {},
  },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DescriptionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  parameters: { expectText: ['0 / 1000'] },
};

export const WithText: Story = {
  args: { initial: 'Production delivery and operational coordination.' },
  parameters: { expectText: ['Production delivery and operational coordination.', '49 / 1000'] },
};

export const OverCap: Story = {
  args: { initial: 'x'.repeat(1001) },
  parameters: { expectText: ['1001 / 1000'] },
};

export const AnnounceToAgentSpaces: Story = {
  args: {
    kind: 'agent',
    subjectName: 'dp1',
    initial: 'Release coordinator.',
    spaces: [fixture.delivery, fixture.sandbox],
  },
  parameters: {
    expectText: ['Description of dp1 updated: Release coordinator.', 'delivery', 'sandbox'],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByLabelText('Announce this change'));
  },
};
