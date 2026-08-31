/**
 * Every story, rendered.
 *
 * The look book is only worth having if it still stands up, and a story that
 * throws is a component that throws. This says nothing about how anything
 * looks — that is what the browser is for — only that each state named in a
 * story is a state the component can actually reach.
 */
import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/react';
import { composeStories } from '@storybook/react-vite';
import type { composeStory } from '@storybook/react-vite';

type StoryModule = Parameters<typeof composeStories>[0];
type Composed = ReturnType<typeof composeStory>;

const modules = import.meta.glob('../src/**/*.stories.tsx', { eager: true });

// A glob that matches nothing would leave this file passing and testing air.
test('there are stories to render', () => {
  expect(Object.keys(modules).length).toBeGreaterThan(10);
});

for (const [path, module] of Object.entries(modules)) {
  const stories = composeStories(module as StoryModule) as Record<string, Composed>;
  describe(path.replace('../src/', ''), () => {
    for (const [name, Story] of Object.entries(stories)) {
      test(name, async () => {
        const { container } = render(<Story />);
        // Whatever the story's own loads settle into, before it is looked at.
        await act(async () => {});
        if (Story.play !== undefined) await Story.play({ canvasElement: container });
        expect(container.innerHTML.trim()).not.toBe('');
      });
    }
  });
}
