import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AttachmentInput, Reader } from '../store/index.js';
import { newAttachmentId } from '../store/index.js';
import type { AttachmentId, Conversation, Message } from '../types.js';
import type { AppContext } from './context.js';
import { invalid, tooLarge } from './errors.js';
import { asIdempotencyKey, HumanPostBody, parse, toTarget } from './validation.js';

/** What both post bodies parse to; the agent's differs only in requiring the key. */
type PostPayload = z.infer<typeof HumanPostBody>;

/**
 * The write behind both post routes: collect the body and any files, size
 * the body, post, and either wake the long polls or — for a replay, which
 * committed nothing — remove the files just written, since they belong to no
 * message. A failure anywhere removes them too.
 */
export async function submitPost<T extends PostPayload>(
  ctx: AppContext,
  request: FastifyRequest,
  schema: z.ZodType<T>,
  sender: Reader,
): Promise<{ readonly message: Message; readonly conversation: Conversation }> {
  const collected = await collectPost(ctx, request, schema);
  const { payload } = collected;
  try {
    const bytes = Buffer.byteLength(payload.body, 'utf8');
    if (bytes > ctx.limits.maxMessageBytes) {
      throw tooLarge(
        `body is ${bytes} bytes, over maxMessageBytes (${ctx.limits.maxMessageBytes})`,
      );
    }
    const result = ctx.store.postMessage({
      sender,
      target: toTarget(payload.target),
      body: payload.body,
      ...(collected.attachments.length === 0 ? {} : { attachments: collected.attachments }),
      ...(payload.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: asIdempotencyKey(payload.idempotencyKey) }),
    });
    if (!result.created) await collected.discard();
    else ctx.writes.agentVisible();
    return { message: result.message, conversation: result.conversation };
  } catch (error) {
    await collected.discard();
    throw error;
  }
}

interface CollectedPost<T> {
  readonly payload: T;
  readonly attachments: readonly AttachmentInput[];
  /** Removes the files written for this request. */
  discard(): Promise<void>;
}

/**
 * A post arrives either as JSON or as multipart: one `request` part holding
 * the JSON, then one part per file. Files stream to the volume as they arrive
 * (`AttachmentInput.id`); the size limit is enforced mid-stream, since a
 * declared Content-Length is the client's claim and a chunked upload makes
 * none.
 */
async function collectPost<T>(
  ctx: AppContext,
  request: FastifyRequest,
  schema: z.ZodType<T>,
): Promise<CollectedPost<T>> {
  if (!request.isMultipart()) {
    return { payload: parse(schema, request.body, 'request body'), attachments: [], discard: noop };
  }

  const written: AttachmentId[] = [];
  const attachments: AttachmentInput[] = [];
  const discard = async (): Promise<void> => {
    for (const id of written) await ctx.files.discard(id);
  };

  let raw: unknown;
  try {
    for await (const part of request.parts()) {
      if (part.fieldname === 'request') {
        if (raw !== undefined) throw invalid('the request part appears more than once');
        raw = parseJson(
          part.type === 'field' ? String(part.value) : (await part.toBuffer()).toString('utf8'),
        );
        continue;
      }
      if (part.type === 'field') continue;

      // Ordering is the contract's, and it is load-bearing: without the JSON
      // there is nothing to attach files to, and writing them anyway would
      // strand bytes on the volume for a request that was never valid.
      if (raw === undefined) throw invalid('the request part must come before any files');
      if (attachments.length >= ctx.limits.maxAttachmentsPerMessage) {
        throw tooLarge(
          `a message carries at most maxAttachmentsPerMessage (${ctx.limits.maxAttachmentsPerMessage}) files`,
        );
      }

      const id = newAttachmentId();
      const file = await ctx.files.write(id, part.file, ctx.limits.maxAttachmentBytes);
      written.push(id);
      attachments.push({
        id,
        // Metadata only. Files are stored under generated ids, so a supplied
        // name never becomes part of a path.
        filename: part.filename === '' ? 'attachment' : part.filename,
        contentType: part.mimetype,
        sizeBytes: file.sizeBytes,
        contentDigest: file.contentDigest,
      });
    }
  } catch (error) {
    await discard();
    throw error;
  }

  if (raw === undefined) {
    await discard();
    throw invalid('multipart posts need a `request` part holding the JSON');
  }

  try {
    return { payload: parse(schema, raw, 'request part'), attachments, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid('the request part is not valid JSON');
  }
}

async function noop(): Promise<void> {
  /* Nothing was written. */
}
