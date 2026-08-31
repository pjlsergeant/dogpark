import type { Meta, StoryObj } from '@storybook/react-vite';
import { SearchScreen } from './Search.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';
import * as fixture from '../stories/fixtures.js';

/**
 * Full text over stored bodies. A snippet is agent-authored and is rendered
 * as plain text, never as markup.
 */
const meta = {
  title: 'Screens/Search',
  component: SearchScreen,
  args: { q: 'rotation' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SearchScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Results: Story = {
  parameters: {
    expectText: ['Staging is on the new credentials and the old key is revoked.'],
  },
};

/** Limited to one space, ordered newest first. */
export const NarrowedToASpace: Story = {
  args: { q: 'rotation', space: fixture.delivery.id, order: 'newest' },
};

export const NoQuery: Story = {
  args: { q: '' },
};

export const NothingMatched: Story = {
  args: { q: 'kubernetes' },
  parameters: {
    api: fixtureApi({
      search: () => Promise.resolve({ items: [], nextCursor: null, hasMore: false }),
    }),
  },
};

/** More than a page of hits. */
export const MoreToLoad: Story = {
  parameters: {
    api: fixtureApi({
      search: () =>
        Promise.resolve({ items: fixture.searchResults, nextCursor: 'qc_s2', hasMore: true }),
    }),
  },
};

export const Loading: Story = {
  parameters: { api: fixtureApi({ search: hangs() }) },
};

export const Failed: Story = {
  parameters: {
    api: fixtureApi({ search: fails(apiError('invalid_request', 'Unbalanced quotes.')) }),
  },
};
