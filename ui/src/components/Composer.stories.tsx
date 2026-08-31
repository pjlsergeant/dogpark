import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';
import { Composer } from './Composer.js';
import * as fixture from '../stories/fixtures.js';
import { apiError, fixtureApi } from '../stories/harness.js';

/**
 * Posting as the human. Send stays out of reach until there is something to
 * send — and, on a new thread, a subject line to send it to.
 */
const meta = {
  title: 'Components/Composer',
  component: Composer,
  args: { space: fixture.delivery.id, onPosted: fn() },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

const sendButton = (canvasElement: HTMLElement): HTMLButtonElement =>
  within(canvasElement).getByRole<HTMLButtonElement>('button', { name: 'Send' });

/** In a thread: a body is the whole requirement. */
export const InAThread: Story = {
  args: { conversation: fixture.rotation.id },
  parameters: { expectText: ['Send'] },
  play: ({ canvasElement }) => {
    expect(sendButton(canvasElement).disabled).toBe(true);
  },
};

/** A new thread needs a subject line as well, so Send waits on both. */
export const NewThread: Story = { parameters: { expectText: ['Start thread'] } };

export const Written: Story = {
  args: { conversation: fixture.rotation.id },
  // The draft lives in the textarea's value, not the DOM text, so what proves
  // this state is the live Send button rather than the words typed into it.
  parameters: { expectText: ['Send'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Message'), 'Checks green. Closing this one out.');
    expect(sendButton(canvasElement).disabled).toBe(false);
  },
};

/** The preview, which is the same renderer the thread uses. */
export const Previewing: Story = {
  args: { conversation: fixture.rotation.id },
  parameters: { expectText: ['replica reconnected'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText('Message'),
      '## Rotation done\n\n- replica reconnected',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Preview' }));
  },
};

/**
 * The reserved sequence is rejected rather than stripped, and the human is
 * bound by it too, so the warning comes before the send does.
 */
export const ControlCharacter: Story = {
  args: { conversation: fixture.rotation.id },
  parameters: { expectText: ['This text contains a control character.'] },
  play: ({ canvasElement }) => {
    const body = within(canvasElement).getByLabelText('Message');
    fireEvent.change(body, { target: { value: 'the log said \u0007 and then stopped' } });
    expect(sendButton(canvasElement).disabled).toBe(true);
  },
};

/** A write that did not land says so, and keeps the draft. */
export const PostFailed: Story = {
  args: { conversation: fixture.rotation.id },
  parameters: {
    expectText: ['Message exceeds 64 kB.'],
    api: fixtureApi({
      post: () => Promise.reject(apiError('too_large', 'Message exceeds 64 kB.')),
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Message'), 'One more thing before I stop.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send' }));
    expect(await canvas.findByText('Message exceeds 64 kB.')).toBeTruthy();
  },
};
