import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tooLarge } from './errors.js';

/** What one file turned out to be, learned on the way past. */
export interface WrittenFile {
  readonly sizeBytes: number;
  /**
   * `sha256:<hex>` over the bytes as they streamed. Hashed here rather than by
   * re-reading the file: the bytes are already in hand, and a second pass over
   * a fifty-megabyte upload to learn something we just had is a waste of the
   * volume.
   *
   * It exists so that a retried post identifies the *file* and not just what
   * the client said about it — without it, two uploads agreeing on name, type
   * and size are the same request as far as an idempotency key is concerned,
   * whatever the bytes say.
   */
  readonly contentDigest: string;
}

/**
 * Attachment bytes on the volume; their metadata is a row in SQLite.
 *
 * Files are written under a generated id before the message row commits, so a
 * crash leaves an unreferenced file rather than a message pointing at nothing
 * (docs/architecture.md). The supplied filename is metadata only and never
 * reaches a path.
 */
export interface AttachmentFiles {
  /** Writes `source`, refusing at `maxBytes`. Returns what it turned out to be. */
  write(id: string, source: Readable, maxBytes: number): Promise<WrittenFile>;
  open(id: string): Promise<Readable | undefined>;
  /** Best effort: a file that cannot be removed is an unreferenced file. */
  discard(id: string): Promise<void>;
}

/** Where attachment bytes live beneath the data directory. One answer, used
 * by the app that writes them and the sweep that collects the strays. */
export function attachmentRoot(dataDir: string): string {
  return join(dataDir, 'attachments');
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
      const digest = createHash('sha256');
      try {
        await pipeline(
          source,
          // Counted and hashed here rather than checked against
          // Content-Length: the declared length is the client's claim, and a
          // chunked upload has none at all. Refusing mid-stream is the only
          // enforcement that costs the disk what the caller actually sent, and
          // the same pass that counts the bytes may as well hash them.
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              written += chunk.length;
              if (written > maxBytes) {
                throw tooLarge(`attachment exceeds maxAttachmentBytes (${maxBytes})`);
              }
              digest.update(chunk);
              yield chunk;
            }
          },
          createWriteStream(path),
        );
      } catch (error) {
        await this.discard(id);
        throw error;
      }
      return { sizeBytes: written, contentDigest: `sha256:${digest.digest('hex')}` };
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
 * Collects files the volume holds and no message references.
 *
 * `minimumAgeMs` guards an upload in flight: a file younger than that is left
 * alone, because a file being streamed right now is not yet referenced by
 * anything either.
 *
 * Returns the ids removed. Best effort throughout: a volume that cannot be
 * read is not a reason to refuse to start.
 */
export async function sweepUnreferenced(
  root: string,
  isReferenced: (id: string) => boolean,
  options: { readonly now?: number | undefined; readonly minimumAgeMs?: number | undefined } = {},
): Promise<readonly string[]> {
  const now = options.now ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? 60 * 60_000;
  const removed: string[] = [];

  let fanout: string[];
  try {
    fanout = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Nothing has ever been uploaded, or the volume is not there. Either way
    // there is nothing to collect.
    return removed;
  }

  for (const bucket of fanout) {
    let names: string[];
    try {
      names = (await readdir(join(root, bucket), { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const id of names) {
      // A name that is not an id was not written here; leave it for a human.
      if (!SAFE_ID.test(id) || isReferenced(id)) continue;
      try {
        const info = await stat(join(root, bucket, id));
        if (now - info.mtimeMs < minimumAgeMs) continue;
        await unlink(join(root, bucket, id));
        removed.push(id);
      } catch {
        /* Gone already, or not ours to remove. */
      }
    }
  }
  return removed;
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
    filename
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\/]/g, '_')
      .trim() || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
