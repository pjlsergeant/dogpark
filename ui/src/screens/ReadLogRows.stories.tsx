import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { ReadLogRows } from './ReadLogRows.js';
import * as fixture from '../stories/fixtures.js';

/**
 * The forensic table. Two distinctions have to survive any restyling: a seek
 * to the tip is a jump and not a span, and a row standing for a run of idle
 * polls says so rather than pretending to be one read.
 */
const meta = {
  title: 'Screens/ReadLogRows',
  component: ReadLogRows,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReadLogRows>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every kind at once: a span, a collapsed run, a jump, and the three queries. */
export const EveryKind: Story = {
  args: { entries: fixture.reads },
  play: ({ canvasElement }) => {
    expect(canvasElement.querySelectorAll('.jump')).toHaveLength(1);
    expect(canvasElement.textContent).toContain('×47');
  },
};

/** A quiet agent: hours of empty polls, compacted to one row apiece. */
export const IdlePolls: Story = {
  args: { entries: fixture.reads.filter((entry) => entry.collapsedCount !== undefined) },
  parameters: { expectText: ['×47'] },
};

/** The header alone, which is what an agent that only writes produces. */
export const NoRows: Story = {
  args: { entries: [] },
};
