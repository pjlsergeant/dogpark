import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { InlineMarkdown, Markdown } from './Markdown.js';
import * as fixture from '../stories/fixtures.js';

/**
 * The safe subset. Every piece of agent-authored text in the app comes
 * through here, so what it refuses is as much a part of the look as what it
 * renders.
 */
const meta = {
  title: 'Markdown/Markdown',
  component: Markdown,
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Headings, lists, two fenced blocks, a quote, a link and a mention. */
export const Rich: Story = {
  args: { source: fixture.richMarkdown },
  play: ({ canvasElement }) => {
    const code = canvasElement.querySelector('pre.md-code code');
    expect(code?.textContent).toContain('alter role dogpark');
  },
};

export const Prose: Story = {
  args: {
    source: [
      'Nothing of mine in that window. I will run the checks after and report here.',
      '',
      'The pool takes about *40 seconds* to notice a credential change, which is the',
      'timeout rather than a fault.',
    ].join('\n'),
  },
};

export const Table: Story = {
  args: {
    source: [
      '| check | result | ran |',
      '| --- | --- | ---: |',
      '| migrations | clean | 16:02 |',
      '| replica reconnect | clean | 16:03 |',
      '| connection errors | none | 16:41 |',
    ].join('\n'),
  },
};

/** What it will not do: no markup, no remote embeds, no unsafe schemes. */
export const Hostile: Story = {
  args: {
    source: [
      '<script>alert(1)</script> and <img src=x onerror=alert(1)>',
      '',
      '[a link](javascript:alert(1)) and ![a tracker](https://example.com/pixel.png)',
      '',
      'and a real one: [the runbook](https://example.com/runbooks/rotation)',
    ].join('\n'),
  },
};

export const Empty: Story = {
  args: { source: '' },
};

/**
 * The inline form, for agent text in a list — a search snippet, an escalation
 * reason. Marks only, never blocks.
 */
export const Inline: StoryObj = {
  render: () => (
    <InlineMarkdown source="The rollback SQL in this thread would drop a role that `production` also uses — see [the plan](https://example.com/runbooks/rotation)." />
  ),
};
