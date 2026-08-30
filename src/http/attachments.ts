import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tooLarge } from './errors.js';

/**
 * Attachment bytes on the volume; their metadata is a row in SQLite.
 *
 * Files are written under a generated id before the message row commits, so a
 * crash leaves an unreferenced file rather than a message pointing at nothing
 * (docs/architecture.md). The supplied filename is metadata only and never
 * reaches a path.
 */
export interface AttachmentFiles {
  /** Writes `source`, refusing at `maxBytes`. Returns the bytes written. */
  write(id: string, source: Readable, maxBytes: number): Promise<number>;
  open(id: string): Promise<Readable | undefined>;
  /** Best effort: a file that cannot be removed is an unreferenced file. */
  discard(id: string): Promise<void>;
}

/** Ids are generated, but a path is never built from a string nobody checked. */
const SAFE_ID = /^[0-9a-z]{4,64}$/;

function pathFor(root: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`refusing to build a path from ${JSON.stringify(id)}`);
  // Two-character fan-out: one directory with a million entries is a directory
  // listing nobody wants to do on a live volume.
  return join(root, id.slice(0, 2), id);
}

export function createAttachmentFiles(root: string): AttachmentFiles {
  return {
    async write(id, source, maxBytes) {
      const path = pathFor(root, id);
      await mkdir(dirname(path), { recursive: true });
      let written = 0;
      try {
        await pipeline(
          source,
          // Counted here rather than checked against Content-Length: the
          // declared length is the client's claim, and a chunked upload has
          // none at all. Refusing mid-stream is the only enforcement that
          // costs the disk what the caller actually sent.
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              written += chunk.length;
              if (written > maxBytes) {
                throw tooLarge(`attachment exceeds maxAttachmentBytes (${maxBytes})`);
              }
              yield chunk;
            }
          },
          createWriteStream(path),
        );
      } catch (error) {
        await this.discard(id);
        throw error;
      }
      return written;
    },

    async open(id) {
      const path = pathFor(root, id);
      try {
        await stat(path);
      } catch {
        return undefined;
      }
      return createReadStream(path);
    },

    async discard(id) {
      try {
        await unlink(pathFor(root, id));
      } catch {
        /* Already gone, or never written. Either way there is nothing to do. */
      }
    },
  };
}

/**
 * A small allowlist. Everything else goes out as `application/octet-stream`.
 *
 * `text/html`, SVG and XML are absent deliberately and not by oversight: the
 * SPA is cookie-authenticated on this origin, so a type the browser will parse
 * as markup is a path from an agent's upload to the admin session. Even the
 * types listed here are served with `Content-Disposition: attachment`.
 */
const ALLOWED = new Set([
  'application/json',
  'application/pdf',
  'application/zip',
  'audio/mpeg',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'video/mp4',
]);

export function safeContentType(declared: string): string {
  const bare = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED.has(bare) ? bare : 'application/octet-stream';
}

/**
 * `filename` is agent-supplied text. The quoted form is reduced to printable
 * ASCII with the quoting characters and path separators removed; the RFC 5987
 * form carries the original, percent-encoded.
 */
export function contentDisposition(filename: string): string {
  const ascii =
    // eslint-disable-next-line no-control-regex
    filename
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\/]/g, '_')
      .trim() || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
