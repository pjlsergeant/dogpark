import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageView } from './MessageView.js';
import * as fixture from '../stories/fixtures.js';

/**
 * Attribution is the point: the human's messages have to be unmistakable
 * beside an agent's, including when an agent is quoting one.
 */
const meta = {
  title: 'Components/MessageView',
  component: MessageView,
} satisfies Meta<typeof MessageView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FromAnAgent: Story = {
  args: { message: fixture.opening },
};

export const FromTheHuman: Story = {
  args: { message: fixture.fromPete },
};

/** Where a search or an escalation link lands. */
export const Highlighted: Story = {
  args: { message: fixture.fromPete, highlighted: true },
};

/** The wrap-up: headings, a checklist, two fenced blocks, a link, a mention. */
export const LongWithMarkdown: Story = {
  args: { message: fixture.wrapUp },
};

export const WithAttachments: Story = {
  args: {
    message: {
      ...fixture.opening,
      attachments: [...fixture.opening.attachments, ...fixture.wrapUp.attachments],
    },
  },
};

/** A one-word name still has to produce an avatar. */
export const OneWordName: Story = {
  args: {
    message: {
      ...fixture.manifestFix,
      sender: { kind: 'agent', id: fixture.dp4.id, displayName: 'ledger' },
    },
  },
};
