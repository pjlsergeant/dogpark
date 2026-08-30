/**
 * Inline markdown → React nodes.
 *
 * The output is React elements and text nodes, never a string of markup:
 * there is no `dangerouslySetInnerHTML` anywhere in this app, so escaping is
 * not something that can be forgotten. Anything unrecognised falls through as
 * literal text, which is the safe direction to fail in.
 */
import type { ReactNode } from 'react';

/**
 * The only schemes a link in agent-authored text may carry. `javascript:`,
 * `data:` and relative links are rendered as plain text with their label
 * intact, so a hostile link is visible rather than silently dropped.
 */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

const ESCAPABLE = '\\`*_{}[]()#+-.!|~<>';

/** `https://…` sitting bare in a sentence. Trailing punctuation is not part of it. */
const BARE_URL = /^https?:\/\/[^\s<>()[\]{}"'`]+/;
const AUTOLINK = /^<((?:https?|mailto):[^\s<>]+)>/;
const LINK = /^\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"[^"]*")?\s*\)/;
const IMAGE = /^!\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"[^"]*")?\s*\)/;
const MENTION = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/;

interface Cursor {
  key: number;
}

function link(href: string, children: ReactNode, key: number): ReactNode {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
      {children}
    </a>
  );
}

/**
 * @param source raw markdown for one inline run
 * @param depth guards against pathological nesting of emphasis
 */
export function renderInline(source: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const cursor: Cursor = { key: 0 };
  let text = '';
  let index = 0;

  const flush = (): void => {
    if (text !== '') {
      out.push(text);
      text = '';
    }
  };
  const push = (node: ReactNode): void => {
    flush();
    out.push(node);
  };

  const emphasis = (marker: string, tag: 'strong' | 'em' | 'del'): boolean => {
    if (depth > 4) return false;
    if (!source.startsWith(marker, index)) return false;
    // `snake_case_identifiers` are not emphasis.
    if (marker.startsWith('_') && index > 0 && /[A-Za-z0-9]/.test(source[index - 1] ?? '')) {
      return false;
    }
    const from = index + marker.length;
    if (source[from] === undefined || /\s/.test(source[from] ?? '')) return false;
    const close = source.indexOf(marker, from);
    if (close === -1) return false;
    const inner = source.slice(from, close);
    if (inner.trim() === '') return false;
    const Tag = tag;
    push(<Tag key={cursor.key++}>{renderInline(inner, depth + 1)}</Tag>);
    index = close + marker.length;
    return true;
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    const rest = source.slice(index);

    // Backslash escapes: the character after it is always literal.
    if (char === '\\') {
      const next = source[index + 1];
      if (next !== undefined && ESCAPABLE.includes(next)) {
        text += next;
        index += 2;
        continue;
      }
    }

    // Code spans win over everything: their content is never markup.
    if (char === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`';
      const close = source.indexOf(run, index + run.length);
      if (close !== -1) {
        const code = source.slice(index + run.length, close);
        push(<code key={cursor.key++}>{code.replace(/^ | $/g, '')}</code>);
        index = close + run.length;
        continue;
      }
    }

    if (char === '!') {
      const image = IMAGE.exec(rest);
      if (image !== null) {
        // Never an inline embed: a remote image is a beacon and a layout
        // hazard, so it is offered as a link and labelled as one.
        const href = safeHref(image[2] ?? '');
        const alt = image[1] ?? '';
        const label = alt === '' ? 'image' : `image: ${alt}`;
        if (href === null) {
          text += `${label} (link not shown)`;
        } else {
          push(
            <span key={cursor.key++} className="md-image-link">
              {link(href, label, cursor.key++)}
            </span>,
          );
        }
        index += image[0].length;
        continue;
      }
    }

    if (char === '[') {
      const match = LINK.exec(rest);
      if (match !== null) {
        const href = safeHref(match[2] ?? '');
        const label = match[1] ?? '';
        if (href === null) {
          // Keep the words, drop the destination.
          push(
            <span
              key={cursor.key++}
              className="md-dead-link"
              title="Link removed: unsupported scheme"
            >
              {renderInline(label, depth + 1)}
            </span>,
          );
        } else {
          push(link(href, renderInline(label, depth + 1), cursor.key++));
        }
        index += match[0].length;
        continue;
      }
    }

    if (char === '<') {
      const auto = AUTOLINK.exec(rest);
      if (auto !== null) {
        const href = safeHref(auto[1] ?? '');
        if (href !== null) {
          push(link(href, auto[1] ?? '', cursor.key++));
          index += auto[0].length;
          continue;
        }
      }
    }

    if (char === 'h' && (index === 0 || /[\s(]/.test(source[index - 1] ?? ''))) {
      const bare = BARE_URL.exec(rest);
      if (bare !== null) {
        const raw = (bare[0] ?? '').replace(/[.,;:!?]+$/, '');
        const href = safeHref(raw);
        if (href !== null) {
          push(link(href, raw, cursor.key++));
          index += raw.length;
          continue;
        }
      }
    }

    if (char === '@' && (index === 0 || /[\s(]/.test(source[index - 1] ?? ''))) {
      const mention = MENTION.exec(rest);
      if (mention !== null) {
        push(
          <span key={cursor.key++} className="md-mention">
            {mention[0]}
          </span>,
        );
        index += mention[0].length;
        continue;
      }
    }

    if (char === '*' || char === '_' || char === '~') {
      if (
        emphasis('***', 'strong') ||
        emphasis('**', 'strong') ||
        emphasis('__', 'strong') ||
        emphasis('~~', 'del') ||
        emphasis('*', 'em') ||
        emphasis('_', 'em')
      ) {
        continue;
      }
    }

    text += char;
    index += 1;
  }

  flush();
  return out;
}

/** Inline markdown with hard line breaks preserved, as a paragraph wants. */
export function renderInlineWithBreaks(source: string): ReactNode[] {
  const lines = source.split('\n');
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`br-${i}`} />);
    out.push(<span key={`ln-${i}`}>{renderInline(line)}</span>);
  });
  return out;
}
