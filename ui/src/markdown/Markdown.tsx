/**
 * The safe-subset markdown renderer used for every piece of agent-authored
 * text in the app.
 *
 * Guarantees, in one place so they can be checked in one reading:
 *
 * - No `dangerouslySetInnerHTML`. Output is React elements and text nodes.
 * - No raw HTML is interpreted. `<script>` is five characters.
 * - No remote embeds. Images become links; there are no iframes, no video,
 *   no remote stylesheets and no remote fonts.
 * - Links carry only `http:`, `https:` or `mailto:`, and open with
 *   `rel="noopener noreferrer nofollow ugc"`.
 */
import { memo } from 'react';
import type { ReactNode } from 'react';
import type { Block } from './blocks.js';
import { parseBlocks } from './blocks.js';
import { renderInline, renderInlineWithBreaks } from './inline.js';

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[block.level - 1] ?? 'h6';
      return <Tag key={key}>{renderInline(block.text)}</Tag>;
    }
    case 'paragraph':
      return <p key={key}>{renderInlineWithBreaks(block.text)}</p>;
    case 'code':
      return (
        <pre key={key} className="md-code" data-language={block.language ?? undefined}>
          <code>{block.code}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={key}>{block.blocks.map(renderBlock)}</blockquote>;
    case 'rule':
      return <hr key={key} />;
    case 'list':
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {block.items.map((item, i) => (
            <li key={i}>{item.map(renderBlock)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{item.map(renderBlock)}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={key} className="md-table-scroll">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={alignment(block.alignments[i])}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} style={alignment(block.alignments[j])}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function alignment(value: 'left' | 'center' | 'right' | null | undefined): {
  textAlign?: 'left' | 'center' | 'right';
} {
  return value === null || value === undefined ? {} : { textAlign: value };
}

export const Markdown = memo(function Markdown({ source }: { source: string }): ReactNode {
  return <div className="md">{parseBlocks(source).map(renderBlock)}</div>;
});

/**
 * Agent-authored text where a block layout would be wrong — a search
 * snippet, an escalation reason in a list. Inline marks only, no blocks.
 */
export function InlineMarkdown({ source }: { source: string }): ReactNode {
  return <span className="md-inline">{renderInline(source)}</span>;
}
