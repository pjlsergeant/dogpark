/**
 * Every story, rendered.
 *
 * The look book is only worth having if it still stands up, and a story that
 * throws is a component that throws. This says nothing about how anything
 * looks — that is what the browser is for — only that each state named in a
 * story is a state the component can actually reach.
 *
 * Non-empty HTML is the floor every story clears. On top of it, every story
 * owes a word on its own text: either it names the string that proves its data
 * rendered (`parameters: { expectText }`, a string or a list of them) and is
 * held to showing it, or it declares it has none (`expectText: null`) for a
 * state that is genuinely text-free. Silence — neither one — is a failure, so
 * a new story cannot quietly settle for "React emitted a character": it has to
 * say what separates "rendered the data" from "rendered a spinner forever".
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
        const expected = Story.parameters['expectText'] as
          string | readonly string[] | null | undefined;
        // Every story either names the text that proves its data rendered or
        // declares it has none. Silence is not an option: a bare story asserts
        // only that React emitted a character, which the innerHTML floor above
        // already covers.
        if (expected === undefined) {
          throw new Error(
            `Story "${path.replace('../src/', '')} > ${name}" must set parameters.expectText: ` +
              `name the text that proves your data rendered, or declare ` +
              `\`expectText: null\` for a state with none.`,
          );
        }
        const texts = typeof expected === 'string' ? [expected] : (expected ?? []);
        if (expected !== null) {
          // A non-null expectText is a promise to name real text: no empty
          // string, no empty list, no blank entries dressed up as an assertion.
          expect(
            Array.isArray(expected) ? expected.length : (expected as string).length,
          ).toBeGreaterThan(0);
          for (const text of texts) expect(text.trim()).not.toBe('');
        }
        for (const text of texts) {
          expect(container.textContent).toContain(text);
        }
      });
    }
  });
}
