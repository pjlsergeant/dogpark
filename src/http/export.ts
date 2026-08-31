import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import type { Store } from '../store/index.js';
import type {
  Conversation,
  ConversationExport,
  ConversationId,
  ExportDocument,
  Message,
  QueryCursor,
  Space,
  SpaceId,
} from '../types.js';
import { ExportDocumentSchema } from '../types.js';
import type { AppContext } from './context.js';
import { notFound } from './errors.js';

const HUMAN = { kind: 'human' } as const;
const PAGE_SIZE = 200;

export interface ExportSource {
  readonly space: Space & { readonly description?: string | undefined };
  readonly conversations: readonly Conversation[];
}

function safeName(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/** The id is the trusted directory; this is display text reduced to one basename. */
export function safeAttachmentBasename(filename: string): string {
  const leaf = basename(filename.replaceAll('\\', '/'));
  return safeName(leaf, 'attachment');
}

export function conversationExportSource(store: Store, id: ConversationId): ExportSource {
  const conversation = store.getConversation(id);
  if (conversation === undefined) throw notFound('conversation');
  const space = store.getSpace(conversation.space);
  /* c8 ignore next -- a conversation cannot outlive its foreign-key parent. */
  if (space === undefined) throw new Error('conversation references a missing space');
  const description = store.getSpaceDescription(space.id);
  return {
    space: { ...space, ...(description === undefined ? {} : { description }) },
    conversations: [conversation],
  };
}

export function spaceExportSource(store: Store, id: SpaceId): ExportSource {
  const space = store.getSpace(id);
  if (space === undefined) throw notFound('space');
  const description = store.getSpaceDescription(id);
  return {
    space: { ...space, ...(description === undefined ? {} : { description }) },
    conversations: store.listConversationsForExport(id),
  };
}

async function* messages(store: Store, conversation: ConversationId): AsyncGenerator<Message> {
  let after: QueryCursor | undefined;
  do {
    const page = store.readConversation(
      HUMAN,
      conversation,
      { order: 'oldest', ...(after === undefined ? {} : { after }) },
      PAGE_SIZE,
    );
    for (const message of page.messages) yield message;
    if (!page.hasMore) return;
    after = page.nextCursor;
  } while (true);
}

function annotationLine(item: ConversationExport): string {
  const pins = item.annotations.pins.map((pin) => pin.actor.displayName).join(', ');
  return `Status: ${item.annotations.status}${pins === '' ? '; pins: none' : `; pins: ${pins}`}`;
}

async function attachmentExists(ctx: AppContext, id: string): Promise<boolean> {
  const stream = await ctx.files.open(id);
  if (stream === undefined) return false;
  stream.destroy();
  return true;
}

async function* markdownChunks(
  ctx: AppContext,
  source: ExportSource,
  linkAttachments: boolean,
): AsyncGenerator<string> {
  if (source.conversations.length !== 1) {
    yield `# ${source.space.name}\n\n`;
    if (source.space.description !== undefined) yield `${source.space.description}\n\n`;
  }
  for (const conversation of source.conversations) {
    const item: ConversationExport = {
      conversation,
      annotations: ctx.store.getConversationAnnotations(conversation.id),
      messages: [],
    };
    yield `${source.conversations.length === 1 ? '#' : '##'} ${conversation.title}\n\n`;
    yield `Space: ${source.space.name}\n\n${annotationLine(item)}\n\n`;
    for await (const message of messages(ctx.store, conversation.id)) {
      yield `### ${message.sender.displayName} — ${message.sentAt}\n\n${message.body}\n\n`;
      if (message.attachments.length > 0) {
        yield `Attachments:\n`;
        for (const attachment of message.attachments) {
          const available = await attachmentExists(ctx, attachment.id);
          const label = `${attachment.filename} (${attachment.contentType}, ${attachment.sizeBytes} bytes)`;
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
      ctx.store.getConversationAnnotations(conversation.id),
    )},"messages":[`;
    let firstMessage = true;
    for await (const message of messages(ctx.store, conversation.id)) {
      if (!firstMessage) yield ',';
      firstMessage = false;
      yield JSON.stringify(message);
    }
    yield ']}';
  }
  yield ']}';
}

export async function exportJson(ctx: AppContext, source: ExportSource): Promise<ExportDocument> {
  const text: string[] = [];
  for await (const chunk of jsonChunks(ctx, source)) text.push(chunk);
  return ExportDocumentSchema.parse(JSON.parse(text.join('')));
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
        for await (const message of messages(ctx.store, conversation.id)) {
          for (const attachment of message.attachments) {
            if (added.has(attachment.id)) continue;
            added.add(attachment.id);
            const stream = await ctx.files.open(attachment.id);
            if (stream === undefined) continue;
            zip.addReadStream(
              stream,
              `attachments/${attachment.id}/${safeAttachmentBasename(attachment.filename)}`,
              { compress: false, size: attachment.sizeBytes },
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
    source.conversations.length === 1
      ? (source.conversations[0]?.title ?? 'conversation')
      : source.space.name,
    'dogpark-export',
  );
}
