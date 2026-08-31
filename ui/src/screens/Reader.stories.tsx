import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReaderScreen } from './Reader.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/**
 * The screen the human actually lives in, and so the one that has to be
 * pleasant: per-agent attribution, day separators, rendered markdown,
 * attachments as downloads, and a composer under it all.
 */
const meta = {
  title: 'Screens/Reader',
  component: ReaderScreen,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReaderScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No space chosen yet: pick one. */
export const PickASpace: Story = {};

/** A thread being wrapped up, over two days. */
export const AThread: Story = {
  args: { space: fixture.delivery.id, conversation: fixture.rotation.id },
  // The pete line lives only in the message pane: a reader stuck on the
  // thread list cannot satisfy it.
  parameters: { expectText: [fixture.rotation.title, 'Do not touch production'] },
};

/** Arriving from a search result, landing on the message it named. */
export const HighlightedMessage: Story = {
  args: {
    space: fixture.delivery.id,
    conversation: fixture.rotation.id,
    message: fixture.fromPete.id,
  },
};

/** No thread chosen: the composer opens one by subject line. */
export const StartingAThread: Story = {
  args: { space: fixture.delivery.id },
};

/**
 * As of a past read: labels as they stood then, a banner saying so, and
 * nothing to post with — the past is not somewhere to say things.
 */
export const AsItWasRead: Story = {
  args: {
    space: fixture.delivery.id,
    conversation: fixture.rotation.id,
    asOf: fixture.conversationRead.id,
  },
};

export const AnEmptySpace: Story = {
  args: { space: fixture.sandbox.id },
};

export const Loading: Story = {
  args: { space: fixture.delivery.id, conversation: fixture.rotation.id },
  parameters: { api: fixtureApi({ listConversations: hangs(), readConversation: hangs() }) },
};

export const Failed: Story = {
  args: { space: fixture.delivery.id, conversation: fixture.rotation.id },
  parameters: {
    api: fixtureApi({ readConversation: fails(apiError('not_found', 'No such conversation.')) }),
  },
};
