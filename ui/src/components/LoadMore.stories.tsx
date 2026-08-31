import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { LoadMore } from './LoadMore.js';
import type { Page, SearchResult } from '../api/index.js';
import type { Pages } from '../app/usePages.js';
import * as fixture from '../stories/fixtures.js';

type Paged = Pages<SearchResult, Page<SearchResult>>;

function pages(over: Partial<Paged> = {}): Paged {
  const first: Page<SearchResult> = {
    items: fixture.searchResults,
    nextCursor: 'qc_next',
    hasMore: true,
  };
  return {
    first: { status: 'ready', data: first, error: null },
    items: first.items,
    hasMore: true,
    busy: false,
    paged: false,
    loadMore: fn(),
    moreFailed: false,
    refresh: fn(),
    ...over,
  };
}

/**
 * The foot of a paged list: one button, and a word if the last try failed.
 * Nothing at all once the list is exhausted, which is why there is no story
 * for that state.
 */
const meta = {
  title: 'Components/LoadMore',
  component: LoadMore,
  args: { label: 'More results' },
} satisfies Meta<typeof LoadMore<SearchResult, Page<SearchResult>>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const More: Story = {
  args: { pages: pages() },
};

export const Loading: Story = {
  args: { pages: pages({ busy: true }) },
};

export const Failed: Story = {
  args: { pages: pages({ moreFailed: true }) },
};
