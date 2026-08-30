import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AttachmentInput } from '../store/index.js';
import { newAttachmentId } from '../store/index.js';
import type { AttachmentId } from '../types.js';
import type { AppContext } from './context.js';
import { invalid, tooLarge } from './errors.js';
import { parse } from './validation.js';

export interface CollectedPost<T> {
  readonly payload: T;
  readonly attachments: readonly AttachmentInput[];
  /** Removes the files written for this request. For a write that failed. */
  discard(): Promise<void>;
}

/**
 * A post arrives either as JSON or as multipart: one `request` part holding
 * the JSON, then one part per file.
 *
 * Files are written to the volume as they stream, before the message row is
 * committed, so a crash leaves an unreferenced file rather than a message
 * pointing at nothing (docs/architecture.md). The size limit is enforced
 * mid-stream: a declared Content-Length is the client's claim, and a chunked
 * upload makes no claim at all.
 */
export async function collectPost<T>(
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

      // Minted through the store's own export rather than by reaching past it
      // into `store/ids.js`: the alphabet and the length are the store's.
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
        // Hashed while streaming to the volume, never by reading it back. It
        // is what makes a retry identify the file rather than the client's
        // description of it: without it, re-posting a *different* file under
        // the same name, type and size replays the original message.
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

export function assertBodyFits(body: string, maxMessageBytes: number): void {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maxMessageBytes) {
    throw tooLarge(`body is ${bytes} bytes, over maxMessageBytes (${maxMessageBytes})`);
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
