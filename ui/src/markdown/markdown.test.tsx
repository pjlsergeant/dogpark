/**
 * The renderer is the one place where hostile input meets the admin origin,
 * so its guarantees are tested rather than asserted.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown.js';
import { safeHref } from './inline.js';
import { parseBlocks } from './blocks.js';

const render = (source: string): string => renderToStaticMarkup(<Markdown source={source} />);

describe('safety', () => {
  it('does not interpret raw HTML', () => {
    const html = render('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops javascript: and data: links but keeps their text', () => {
    const html = render('[click me](javascript:alert(1)) [file](data:text/html,<script>)');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('click me');
    expect(html).toContain('file');
  });

  it('keeps http, https and mailto links, and marks them safe to follow', () => {
    const html = render('[a](https://example.com/x?y=1) <mailto:someone@example.com>');
    expect(html).toContain('href="https://example.com/x?y=1"');
    expect(html).toContain('mailto:someone@example.com');
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it('never embeds an image, only links to one', () => {
    const html = render('![alt](https://example.com/tracker.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('https://example.com/tracker.png');
    expect(html).toContain('image: alt');
  });

  it('escapes markup inside code spans and fences', () => {
    const html = render('`<b>x</b>`\n\n```\n<i>y</i>\n```');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('rejects every scheme but the three', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref(' JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHref('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(safeHref('vbscript:msgbox')).toBeNull();
    expect(safeHref('/api/admin/spaces')).toBeNull();
    expect(safeHref('https://example.com')).toBe('https://example.com/');
  });
});

describe('the subset it does render', () => {
  it('handles headings, lists, quotes, rules and emphasis', () => {
    const html = render(
      ['## Title', '', '- one', '- two', '', '> quoted', '', '---', '', '**bold** and *thin*'].join(
        '\n',
      ),
    );
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<li><p>one</p></li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr/>');
    expect(html).toContain('<strong>');
    expect(html).toContain('<em>');
  });

  it('renders a table', () => {
    const html = render('| a | b |\n| --- | ---: |\n| 1 | 2 |');
    expect(html).toContain('<th>');
    expect(html).toContain('text-align:right');
    expect(html).toContain('<td>1</td>');
  });

  it('leaves an unclosed fence as code rather than swallowing the document', () => {
    const blocks = parseBlocks('```\nnever closed');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
  });

  it('does not emphasise inside identifiers', () => {
    expect(render('snake_case_name')).toContain('snake_case_name');
  });

  it('marks mentions without inventing a link', () => {
    const html = render('hello @ledger');
    expect(html).toContain('md-mention');
    expect(html).not.toContain('<a');
  });
});
