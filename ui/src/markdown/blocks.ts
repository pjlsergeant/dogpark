/**
 * Markdown → a small block AST.
 *
 * A deliberately small subset, parsed by this app rather than delegated to a
 * library: agent-authored text shares an origin with the admin session, so
 * the rendering path is one of the two things in this UI that has to be
 * right (docs/architecture.md, "Untrusted content").
 *
 * Nothing here interprets HTML. A `<` is a `<`, and stays one all the way to
 * a React text node.
 */

export type Block =
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'code'; readonly language: string | null; readonly code: string }
  | { readonly type: 'quote'; readonly blocks: readonly Block[] }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly Block[])[];
    }
  | { readonly type: 'rule' }
  | {
      readonly type: 'table';
      readonly header: readonly string[];
      readonly alignments: readonly ('left' | 'center' | 'right' | null)[];
      readonly rows: readonly (readonly string[])[];
    };

/** Nesting deeper than this is a document doing something odd; flatten it. */
const MAX_DEPTH = 6;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?(\s*:?-{1,}:?\s*\|)+(\s*:?-{1,}:?\s*)\|?\s*$/;

function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function alignmentOf(cell: string): 'left' | 'center' | 'right' | null {
  const left = cell.trim().startsWith(':');
  const right = cell.trim().endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

export function parseBlocks(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  const paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      paragraph.length = 0;
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      flushParagraph();
      const marker = fence[1] ?? '```';
      const language = (fence[2] ?? '').trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trimEnd() !== marker) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // closing fence, or the end of the document
      blocks.push({
        type: 'code',
        language: language === '' ? null : language,
        code: body.join('\n'),
      });
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      const level = Math.min(6, (heading[1] ?? '#').length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? '';
        const match = QUOTE.exec(candidate);
        if (match !== null) {
          quoted.push(match[1] ?? '');
          index += 1;
          continue;
        }
        // Lazy continuation: a plain line directly under a quote stays in it.
        if (candidate.trim() !== '' && quoted.length > 0) {
          quoted.push(candidate);
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'quote',
        blocks:
          depth >= MAX_DEPTH
            ? [{ type: 'paragraph', text: quoted.join('\n') }]
            : parseBlocks(quoted.join('\n'), depth + 1),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number.parseInt(ordered[2] ?? '1', 10) : 1;
      const items: string[][] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? '';
        const itemBullet = BULLET.exec(candidate);
        const itemOrdered = ORDERED.exec(candidate);
        const matched = isOrdered ? itemOrdered : itemBullet;
        if (matched !== null) {
          items.push([matched[3] ?? '']);
          index += 1;
          continue;
        }
        if (candidate.trim() === '') {
          // A blank line ends the list unless the next line is indented into it.
          const next = lines[index + 1] ?? '';
          if (/^\s{2,}\S/.test(next)) {
            items[items.length - 1]?.push('');
            index += 1;
            continue;
          }
          break;
        }
        if (/^\s{2,}\S/.test(candidate) || items.length > 0) {
          // Indented continuation, or a lazy one belonging to the last item.
          if (items.length === 0) break;
          items[items.length - 1]?.push(candidate.replace(/^ {1,4}/, ''));
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'list',
        ordered: isOrdered,
        start: Number.isFinite(start) ? start : 1,
        items: items.map((item) => {
          const text = item.join('\n');
          return depth >= MAX_DEPTH
            ? [{ type: 'paragraph', text } as Block]
            : parseBlocks(text, depth + 1);
        }),
      });
      continue;
    }

    // A table is a header row followed by a divider row; anything else with a
    // pipe in it is just a paragraph.
    if (line.includes('|') && TABLE_DIVIDER.test(lines[index + 1] ?? '')) {
      flushParagraph();
      const header = splitRow(line);
      const alignments = splitRow(lines[index + 1] ?? '').map(alignmentOf);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? '';
        if (candidate.trim() === '' || !candidate.includes('|')) break;
        const cells = splitRow(candidate);
        // Ragged rows are normal in hand-written markdown; pad rather than drop.
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length));
        index += 1;
      }
      blocks.push({ type: 'table', header, alignments, rows });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}
