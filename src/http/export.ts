import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import type { SnapshotPosition, Store } from '../store/index.js';
import type {
  Conversation,
  ConversationAnnotations,
  ConversationExport,
  ConversationId,
  Message,
  QueryCursor,
  Space,
  SpaceId,
} from '../types.js';
import type { AppContext } from './context.js';
import { notFound } from './errors.js';

const HUMAN = { kind: 'human' } as const;
const PAGE_SIZE = 200;

/**
 * One export is one snapshot. The bundle walks each conversation three times
 * — markdown, JSON, attachments — as separate paged reads, so a post landing
 * mid-export would otherwise put a message in the .json that the .md never
 * saw. `tip` is the stream seq when the export began: every walk reads at or
 * below it and the annotations are taken as of it, so the documents in one
 * archive agree. A seq, not the clock — a message committed earlier in the
 * same millisecond the export starts is before the export, and a timestamp
 * bound could not say so. Message rendering — sender names, mentions, the
 * title a message carries — is as of the same position; the space and thread
 * headers are current labels, since a space name is not journaled at all.
 */
export interface ExportSource {
  /** What was asked for — a space of one thread is still a space export. */
  readonly kind: 'conversation' | 'space';
  readonly space: Space & { readonly description?: string | undefined };
  readonly conversations: readonly Conversation[];
  readonly position: SnapshotPosition;
  readonly annotations: ReadonlyMap<ConversationId, ConversationAnnotations>;
}

function snapshot(
  ctx: AppContext,
  kind: ExportSource['kind'],
  space: ExportSource['space'],
  conversations: readonly Conversation[],
): ExportSource {
  const position = ctx.store.snapshotPosition();
  const annotations = new Map<ConversationId, ConversationAnnotations>();
  for (const conversation of conversations) {
    annotations.set(
      conversation.id,
      ctx.store.getConversationAnnotationsAsOf(
        conversation.id,
        { tip: position.tip },
        position.labelSeq,
      ),
    );
  }
  return { kind, space, conversations, position, annotations };
}

function safeName(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * Text that lands inside generated markdown structure — a link label, a
 * heading — rather than as a message body (which is markdown by design). A
 * filename such as `report](https://evil/x` must not become a link, and a
 * title carrying a newline must not start a list or a fence on the next
 * line: block constructs need a line start, so line breaks become a space and
 * the inline constructs are escaped. Only line breaks: a title is an exact
 * identifier and two of them may differ by a doubled space, which the export
 * keeps as written.
 */
export function markdownText(value: string): string {
  return value.replace(/[\r\n\v\f\u2028\u2029]+/g, ' ').replace(/[\\`*_[\]()<>#|~]/g, '\\$&');
}

/**
 * `markdownText` for a value that opens its own line, where a leading list
 * marker (`- `, `+ `, `1. `, `1) `) or a run of hyphens would still be
 * structure. The first such character is escaped; `*` and `_` already are.
 */
export function markdownLine(value: string): string {
  // Leading whitespace has no meaning on a line of its own, and CommonMark
  // would read a marker behind up to three spaces — or a code block behind
  // four — so it goes first.
  return markdownText(value)
    .replace(/^\s+/, '')
    .replace(/^(\d+)([.)])/, '$1\\$2')
    .replace(/^([-+])/, '\\$1');
}

/** The id is the trusted directory; this is display text reduced to one basename. */
export function safeAttachmentBasename(filename: string): string {
  const leaf = basename(filename.replaceAll('\\', '/'));
  return safeName(leaf, 'attachment');
}

export function conversationExportSource(ctx: AppContext, id: ConversationId): ExportSource {
  const { store } = ctx;
  const conversation = store.getConversation(id);
  if (conversation === undefined) throw notFound('conversation');
  const space = store.getSpace(conversation.space);
  /* c8 ignore next -- a conversation cannot outlive its foreign-key parent. */
  if (space === undefined) throw new Error('conversation references a missing space');
  const description = store.getSpaceDescription(space.id);
  return snapshot(
    ctx,
    'conversation',
    { ...space, ...(description === undefined ? {} : { description }) },
    [conversation],
  );
}

export function spaceExportSource(ctx: AppContext, id: SpaceId): ExportSource {
  const { store } = ctx;
  const space = store.getSpace(id);
  if (space === undefined) throw notFound('space');
  const description = store.getSpaceDescription(id);
  return snapshot(
    ctx,
    'space',
    { ...space, ...(description === undefined ? {} : { description }) },
    store.listConversationsForExport(id),
  );
}

async function* messages(
  store: Store,
  conversation: ConversationId,
  position: SnapshotPosition,
): AsyncGenerator<Message> {
  let after: QueryCursor | undefined;
  do {
    const page = store.readConversation(
      HUMAN,
      conversation,
      { order: 'oldest', ...(after === undefined ? {} : { after }) },
      PAGE_SIZE,
      position,
    );
    for (const message of page.messages) yield message;
    if (!page.hasMore) return;
    after = page.nextCursor;
  } while (true);
}

function annotationsOf(source: ExportSource, conversation: Conversation): ConversationAnnotations {
  /* c8 ignore next -- the snapshot covers exactly the conversations it lists. */
  return source.annotations.get(conversation.id) ?? { status: 'open', pins: [] };
}

function annotationLine(item: ConversationExport): string {
  const pins = item.annotations.pins.map((pin) => markdownText(pin.actor.displayName)).join(', ');
  return `Status: ${item.annotations.status}${pins === '' ? '; pins: none' : `; pins: ${pins}`}`;
}

async function* markdownChunks(
  ctx: AppContext,
  source: ExportSource,
  linkAttachments: boolean,
): AsyncGenerator<string> {
  if (source.kind === 'space') {
    yield `# ${markdownText(source.space.name)}\n\n`;
    // Plain operator text, not markdown: on its own line it could otherwise
    // open a heading, a list or a fence.
    if (source.space.description !== undefined) {
      yield `${markdownLine(source.space.description)}\n\n`;
    }
  }
  for (const conversation of source.conversations) {
    const item: ConversationExport = {
      conversation,
      annotations: annotationsOf(source, conversation),
      messages: [],
    };
    yield `${source.kind === 'space' ? '##' : '#'} ${markdownText(conversation.title)}\n\n`;
    yield `Space: ${markdownText(source.space.name)}\n\n${annotationLine(item)}\n\n`;
    for await (const message of messages(ctx.store, conversation.id, source.position)) {
      yield `### ${markdownText(message.sender.displayName)} — ${message.sentAt}\n\n${message.body}\n\n`;
      if (message.attachments.length > 0) {
        yield `Attachments:\n`;
        for (const attachment of message.attachments) {
          const available = (await ctx.files.pathOf(attachment.id)) !== undefined;
          const label = `${markdownText(attachment.filename)} (${markdownText(attachment.contentType)}, ${attachment.sizeBytes} bytes)`;
          const path = `attachments/${attachment.id}/${safeAttachmentBasename(attachment.filename)}`;
          yield available
            ? linkAttachments
              ? `- [${label}](${path})\n`
              : `- ${label}\n`
            : `- ${label} — missing from storage\n`;
        }
        yield '\n';
      }
    }
  }
}

async function* jsonChunks(ctx: AppContext, source: ExportSource): AsyncGenerator<string> {
  yield `{"space":${JSON.stringify(source.space)},"conversations":[`;
  let firstConversation = true;
  for (const conversation of source.conversations) {
    if (!firstConversation) yield ',';
    firstConversation = false;
    yield `{"conversation":${JSON.stringify(conversation)},"annotations":${JSON.stringify(
      annotationsOf(source, conversation),
    )},"messages":[`;
    let firstMessage = true;
    for await (const message of messages(ctx.store, conversation.id, source.position)) {
      if (!firstMessage) yield ',';
      firstMessage = false;
      yield JSON.stringify(message);
    }
    yield ']}';
  }
  yield ']}';
}

/**
 * Streamed like the other two formats: a whole space is never held in memory
 * twice over. The document's shape is `ExportDocumentSchema`, which the route
 * test parses the response against, so the schema stays load-bearing without
 * a parse on the hot path.
 */
export function exportJson(ctx: AppContext, source: ExportSource): Readable {
  return Readable.from(jsonChunks(ctx, source));
}

export function exportMarkdown(ctx: AppContext, source: ExportSource): Readable {
  return Readable.from(markdownChunks(ctx, source, false));
}

export function exportBundle(ctx: AppContext, source: ExportSource, rootName: string): Readable {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const markdown = Readable.from(markdownChunks(ctx, source, true));
  const json = Readable.from(jsonChunks(ctx, source));
  zip.addReadStream(markdown, `${rootName}.md`);
  zip.addReadStream(json, `${rootName}.json`);

  void (async () => {
    try {
      const added = new Set<string>();
      for (const conversation of source.conversations) {
        for await (const message of messages(ctx.store, conversation.id, source.position)) {
          for (const attachment of message.attachments) {
            if (added.has(attachment.id)) continue;
            added.add(attachment.id);
            const path = await ctx.files.pathOf(attachment.id);
            if (path === undefined) continue;
            // By path, not stream: yazl opens each file when the archive
            // reaches it, so a bundle of many attachments holds one descriptor
            // at a time rather than one per entry.
            zip.addFile(
              path,
              `attachments/${attachment.id}/${safeAttachmentBasename(attachment.filename)}`,
              { compress: false },
            );
          }
        }
      }
      zip.end();
    } catch (error) {
      output.destroy(error as Error);
    }
  })();
  return output;
}

export function exportRootName(source: ExportSource): string {
  return safeName(
    source.kind === 'conversation'
      ? (source.conversations[0]?.title ?? 'conversation')
      : source.space.name,
    'dogpark-export',
  );
}
