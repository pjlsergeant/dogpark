import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ToastHost, useNotify } from './Toasts.js';

/** Transient confirmations and failures, announced politely and dismissable. */
const meta = {
  title: 'Components/Toasts',
  component: ToastHost,
} satisfies Meta<typeof ToastHost>;

export default meta;
type Story = StoryObj<typeof meta>;

function Raise(): ReactNode {
  const notify = useNotify();
  return (
    <div className="row">
      <button type="button" className="btn" onClick={() => notify('ok', 'Renamed.')}>
        Something worked
      </button>
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => notify('bad', 'rate_limited — 40 requests a minute. Retry after 12s.')}
      >
        Something did not
      </button>
    </div>
  );
}

export const Quiet: Story = {
  args: { children: <Raise /> },
  // Nothing has been raised yet, so only the triggers are on screen.
  parameters: { expectText: ['Something worked'] },
};

export const Confirmation: Story = {
  args: { children: <Raise /> },
  parameters: { expectText: ['Renamed.'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Something worked' }));
    expect(await canvas.findByText('Renamed.')).toBeTruthy();
  },
};

/** A failure stays on screen more than twice as long as a confirmation. */
export const Failure: Story = {
  args: { children: <Raise /> },
  parameters: { expectText: ['rate_limited — 40 requests a minute. Retry after 12s.'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Something did not' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Something worked' }));
    expect(await canvas.findByText('Renamed.')).toBeTruthy();
  },
};
