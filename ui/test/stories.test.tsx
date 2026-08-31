/**
 * Every story, rendered.
 *
 * The look book is only worth having if it still stands up, and a story that
 * throws is a component that throws. This says nothing about how anything
 * looks — that is what the browser is for — only that each state named in a
 * story is a state the component can actually reach. A story that names the
 * text it should show (`parameters: { expectText }`) is additionally held to
 * showing it, which is what separates "rendered the data" from "rendered a
 * spinner forever".
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

// Every component and screen has a story file: a new screen cannot land
// outside the look book. Markdown and App live outside these directories —
// Markdown has stories anyway; App is the shell and has none on purpose.
test('every component and screen has stories', () => {
  const sources = import.meta.glob('../src/{components,screens}/*.tsx');
  const missing = Object.keys(sources)
    .filter((path) => !path.endsWith('.test.tsx') && !path.endsWith('.stories.tsx'))
    .filter((path) => !(path.replace(/\.tsx$/, '.stories.tsx') in modules));
  // A source exporting two screens satisfies the sibling rule with one story
  // file, so the second screen's stories are demanded by name.
  for (const extra of ['../src/screens/SpaceScreen.stories.tsx']) {
    if (!(extra in modules)) missing.push(extra);
  }
  expect(missing).toEqual([]);
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
        const expected = Story.parameters['expectText'] as string | readonly string[] | undefined;
        for (const text of typeof expected === 'string' ? [expected] : (expected ?? [])) {
          expect(container.textContent).toContain(text);
        }
      });
    }
  });
}
