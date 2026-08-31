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
export const PickASpace: Story = { parameters: { expectText: ['delivery'] } };

/** A thread being wrapped up, over two days. */
export const AThread: Story = {
  args: { space: fixture.delivery.id, conversation: fixture.rotation.id },
  // The pete line lives only in the message pane: a reader stuck on the
  // thread list cannot satisfy it.
  parameters: { expectText: [fixture.rotation.title, 'Do not touch production'] },
};

/** Pins from several actors converge on the wrap-up and remain individually attributed. */
export const OpenWithPins: Story = {
  args: { space: fixture.delivery.id, conversation: fixture.rotation.id },
  parameters: { expectText: ['Pinned', 'pinned by dp1, dp2'] },
};

export const CompleteThread: Story = {
  args: { space: fixture.delivery.id, conversation: fixture.backups.id },
  parameters: { expectText: ['complete', 'Reopen'] },
};

export const ListingWithAnnotations: Story = {
  args: { space: fixture.delivery.id },
  parameters: { expectText: ['complete', '📌'] },
};

/** Arriving from a search result, landing on the message it named. */
export const HighlightedMessage: Story = {
  args: {
    space: fixture.delivery.id,
    conversation: fixture.rotation.id,
    message: fixture.fromPete.id,
  },
  parameters: { expectText: ['Do not touch production'] },
};

/** No thread chosen: the composer opens one by subject line. */
export const StartingAThread: Story = {
  args: { space: fixture.delivery.id },
  // The thread list is the data here; the composer under it is the same one
  // Composer.stories covers.
  parameters: { expectText: [fixture.rotation.title] },
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
  // The banner names the agent and read it is standing in; the messages under
  // it are the thread as it was then.
  parameters: { expectText: ['could have seen it at', 'Do not touch production'] },
};

export const AnEmptySpace: Story = {
  args: { space: fixture.sandbox.id },
  parameters: { expectText: ['No threads match.'] },
};

export const Loading: Story = {
  args: { space: fixture.delivery.id, conversation: fixture.rotation.id },
  parameters: {
    expectText: ['Loading threads'],
    api: fixtureApi({ listConversations: hangs(), readConversation: hangs() }),
  },
};

export const Failed: Story = {
  args: { space: fixture.delivery.id, conversation: fixture.rotation.id },
  parameters: {
    expectText: ['No such conversation.'],
    api: fixtureApi({ readConversation: fails(apiError('not_found', 'No such conversation.')) }),
  },
};
