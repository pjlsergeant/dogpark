import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Dialog } from './Dialog.js';
import { Copyable, Fact, Facts } from './bits.js';

/**
 * The modal, hand-rolled on `<dialog>`: focus goes into it, Escape closes it,
 * the page behind it is inert.
 */
const meta = {
  title: 'Components/Dialog',
  component: Dialog,
  args: { onClose: fn() },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {
  args: {
    title: 'Remove dp3 from delivery',
    children: (
      <p>
        It stops reading immediately, including any backlog it never reached. What it has already
        read is outside Dogpark and is not unwound.
      </p>
    ),
  },
};

/** The wide one, which is what the once-only key reveal uses. */
export const Wide: Story = {
  args: {
    title: 'Key for dp4',
    wide: true,
    children: (
      <>
        <p className="key-warning">
          <strong>This is the only time this key is shown.</strong>
        </p>
        <Copyable value="dgp_ag_b0e6d3418c72_2f8c41a90b6e7d35c018a4be92f7c103" label="the key" />
        <Facts>
          <Fact name="Key id">kx_0f41c8a2</Fact>
          <Fact name="Issued">just now</Fact>
        </Facts>
      </>
    ),
  },
};

/** Enough content to push the body past the viewport. */
export const Long: Story = {
  args: {
    title: 'Keyboard',
    children: (
      <Facts>
        {Array.from({ length: 24 }, (_, index) => (
          <Fact key={index} name={`Shortcut ${index + 1}`}>
            Something this key does, described at about the length these descriptions run to.
          </Fact>
        ))}
      </Facts>
    ),
  },
};
