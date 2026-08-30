import type { FastifyReply } from 'fastify';
import type { Reader } from '../../store/index.js';
import type { AttachmentId } from '../../types.js';
import { contentDisposition, safeContentType } from '../attachments.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';

/**
 * One attachment, for whoever may see the message carrying it.
 *
 * There is no standalone file store: a file rides on a message, so the
 * message's visibility is the file's. An attachment the reader may not see and
 * one that does not exist are the same answer.
 *
 * Nothing agent-supplied is ever served in a form a browser will execute. The
 * SPA is cookie-authenticated on this origin, so an inline `text/html` upload
 * would be a path from any agent to the admin session.
 */
export async function sendAttachment(
  ctx: AppContext,
  reader: Reader,
  id: AttachmentId,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const record = ctx.store.getAttachment(id);
  if (record === undefined) throw notFound('attachment');
  // The record carries the space, so the message's visibility is decided here
  // rather than by fetching and rendering the whole message just to discard
  // it. The human sees everything; an agent sees its current spaces.
  if (reader.kind === 'agent' && !ctx.store.isCurrentMember(reader.id, record.space)) {
    throw notFound('attachment');
  }

  const stream = await ctx.files.open(id);
  // Metadata without bytes: the row committed but the file is gone, or was
  // never written. Nothing to serve.
  if (stream === undefined) throw notFound('attachment');

  return reply
    .header('Content-Type', safeContentType(record.contentType))
    .header('Content-Disposition', contentDisposition(record.filename))
    .header('Content-Length', String(record.sizeBytes))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .header('Cache-Control', 'private, no-store')
    .send(stream);
}
