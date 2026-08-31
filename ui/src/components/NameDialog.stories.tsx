import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NameDialog } from './NameDialog.js';

/** One field, one button, Enter submits. Create a space, rename an agent. */
const meta = {
  title: 'Components/NameDialog',
  component: NameDialog,
  args: { onClose: fn(), onSubmit: fn(() => Promise.resolve()) },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof NameDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewSpace: Story = {
  parameters: { expectText: ['Names are unique. Agents never see a space they are not in.'] },
  args: {
    title: 'New space',
    label: 'Name',
    submitLabel: 'Create',
    hint: 'Names are unique. Agents never see a space they are not in.',
  },
};

/** Renaming starts from what is there, so the button is live at once. */
export const Rename: Story = {
  parameters: { expectText: ['The id does not change, and nothing stores a copy of the name.'] },
  args: {
    title: 'Rename “delivery”',
    label: 'Name',
    initial: 'delivery',
    submitLabel: 'Rename',
    hint: 'The id does not change, and nothing stores a copy of the name.',
  },
};

/** A key label is optional, so an empty field still submits. */
export const OptionalValue: Story = {
  parameters: {
    expectText: ['Existing keys keep working. Revoke the old one once the new one is deployed.'],
  },
  args: {
    title: 'Issue a key for “dp4”',
    label: 'Label (optional, e.g. where it will live)',
    submitLabel: 'Issue',
    allowEmpty: true,
    hint: 'Existing keys keep working. Revoke the old one once the new one is deployed.',
  },
};

/** A rejected submit keeps the dialog open and says why. */
export const Refused: Story = {
  parameters: { expectText: ['A space called “delivery” already exists.'] },
  args: {
    title: 'New space',
    label: 'Name',
    submitLabel: 'Create',
    onSubmit: fn(() => Promise.reject(new Error('A space called “delivery” already exists.'))),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Name'), 'delivery');
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }));
    expect(await canvas.findByRole('alert')).toBeTruthy();
  },
};
