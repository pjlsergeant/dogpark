import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import type { Store } from '../store/index.js';
import { openStore, RESERVED_SEQUENCE } from '../store/index.js';
import type { AgentId, ConversationId, SpaceId } from '../types.js';
import { buildApp } from './app.js';
import { contentDisposition, safeContentType } from './attachments.js';
import { hashPassword } from './password.js';

const PASSWORD = 'a correct horse battery staple';
// Hashed once: scrypt is deliberately slow, and every harness reuses this.
const PASSWORD_HASH = hashPassword(PASSWORD);

interface Harness {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly config: Config;
  readonly dir: string;
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'dogpark-http-'));
  const config = loadConfig({
    DOGPARK_PASSWORD_HASH: PASSWORD_HASH,
    DOGPARK_TRUST_PROXY: 'no',
    DOGPARK_DATA_DIR: dir,
    DOGPARK_MAX_WAIT_SECONDS: '2',
    ...env,
  });
  const store = openStore({
    file: join(dir, 'dogpark.sqlite'),
    humanDisplayName: config.DOGPARK_DISPLAY_NAME,
  });
  return { app: await buildApp({ store, config }), store, config, dir };
}

function teardown(h: Harness): Promise<void> {
  return h.app.close().then(() => {
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });
}

function attachmentFiles(h: Harness): string[] {
  const root = join(h.dir, 'attachments');
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(path, entry.name));
      else found.push(entry.name);
    }
  };
  try {
    walk(root);
  } catch {
    /* Nothing has been uploaded. */
  }
  return found;
}

interface MultipartPart {
  readonly name: string;
  readonly value?: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly data?: Buffer;
}

function multipart(parts: readonly MultipartPart[]): { body: Buffer; contentType: string } {
  const boundary = '----dogparktestboundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`, 'utf8'));
    chunks.push(part.data ?? Buffer.from(part.value ?? '', 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function login(h: Harness): Promise<{ cookie: string; csrf: string }> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/admin/session',
    payload: { password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '');
  return {
    cookie: raw.split(';')[0] ?? '',
    csrf: (response.json() as { csrfToken: string }).csrfToken,
  };
}

// ---------------------------------------------------------------------------

describe('the HTTP surface', () => {
  let h: Harness;
  let alpha: { id: AgentId; key: string };
  let beta: { id: AgentId; key: string };
  let space: SpaceId;
  let conversation: ConversationId;

  beforeEach(async () => {
    h = await harness();
    const a = h.store.createAgent('alpha');
    const b = h.store.createAgent('beta');
    alpha = { id: a.id, key: h.store.issueKey(a.id).key };
    beta = { id: b.id, key: h.store.issueKey(b.id).key };
    space = h.store.createSpace('money-and-life').id;
    h.store.grantMembership(alpha.id, space);
    conversation = h.store.resolveOrCreateConversation(space, '2027 budget').id;
  });

  afterEach(async () => {
    await teardown(h);
  });

  const asAgent = (key: string, options: InjectOptions): Promise<LightMyRequestResponse> =>
    h.app.inject({
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${key}` },
    });

  // -------------------------------------------------------------------------
  describe('agent authentication', () => {
    it('refuses a request with no bearer token', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/api/agent/identity' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'unauthenticated' });
    });

    it('refuses a key that does not verify, and counts the attempt against the id', async () => {
      const response = await asAgent(`dgp_${alpha.id}_deadbeef`, {
        method: 'GET',
        url: '/api/agent/identity',
      });
      expect(response.statusCode).toBe(401);
      expect(h.store.getAgent(alpha.id)?.failedAuthAttempts).toBe(1);
      expect(h.store.getAgent(alpha.id)?.lastSeenAt).toBeNull();
    });

    it('answers identity with spaces, limits and the reserved sequence', async () => {
      const response = await asAgent(alpha.key, { method: 'GET', url: '/api/agent/identity' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        self: { id: string };
        spaces: { id: string }[];
        limits: { maxWaitSeconds: number };
        reservedSequence: string;
      };
      expect(body.self.id).toBe(alpha.id);
      expect(body.spaces.map((s) => s.id)).toEqual([space]);
      expect(body.limits.maxWaitSeconds).toBe(2);
      expect(body.reservedSequence).toBe(RESERVED_SEQUENCE);
    });

    it('needs no CSRF token on a bearer route', async () => {
      const response = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: { target: { conversation }, body: 'no cookie, no token', idempotencyKey: 'k1' },
      });
      expect(response.statusCode).toBe(200);
    });

    it('rate limits per agent, and says how long to wait', async () => {
      const limited = await harness({ DOGPARK_REQUESTS_PER_MINUTE: '2' });
      try {
        const agent = limited.store.createAgent('busy');
        const key = limited.store.issueKey(agent.id).key;
        const call = (): Promise<LightMyRequestResponse> =>
          limited.app.inject({
            method: 'GET',
            url: '/api/agent/identity',
            headers: { authorization: `Bearer ${key}` },
          });
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        const third = await limited.app.inject({
          method: 'GET',
          url: '/api/agent/identity',
          headers: { authorization: `Bearer ${key}` },
        });
        expect(third.statusCode).toBe(429);
        expect(third.json()).toMatchObject({ code: 'rate_limited' });
        expect((third.json() as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(
          0,
        );
        expect(third.headers['retry-after']).toBeDefined();
      } finally {
        await teardown(limited);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('what a caller may not see is not_found', () => {
    beforeEach(async () => {
      await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: { target: { conversation }, body: 'private', idempotencyKey: 'seed' },
      });
    });

    it('hides a space the agent is not in', async () => {
      const response = await asAgent(beta.key, {
        method: 'GET',
        url: `/api/agent/spaces/${space}/messages`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found' });
    });

    it('answers identically for a space that does not exist', async () => {
      const absent = await asAgent(beta.key, {
        method: 'GET',
        url: '/api/agent/spaces/0000000000000000/messages',
      });
      const foreign = await asAgent(beta.key, {
        method: 'GET',
        url: `/api/agent/spaces/${space}/messages`,
      });
      expect(absent.statusCode).toBe(foreign.statusCode);
      expect(absent.json()).toEqual(foreign.json());
    });

    it('hides a conversation in a space the agent is not in', async () => {
      const response = await asAgent(beta.key, {
        method: 'GET',
        url: `/api/agent/conversations/${conversation}/messages`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found' });
    });

    it('refuses a post into a foreign conversation as not_found', async () => {
      const response = await asAgent(beta.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: { target: { conversation }, body: 'let me in', idempotencyKey: 'x' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found' });
    });

    it('never lets an outsider enumerate agents, or probe a space by naming it', async () => {
      const list = await asAgent(beta.key, { method: 'GET', url: '/api/agent/agents' });
      expect(list.json()).toEqual([]);

      const probe = await asAgent(beta.key, {
        method: 'GET',
        url: `/api/agent/agents?space=${space}`,
      });
      expect(probe.statusCode).toBe(404);
    });

    it('hides an attachment on a message the agent cannot see', async () => {
      const form = multipart([
        {
          name: 'request',
          value: JSON.stringify({
            target: { conversation },
            body: 'report',
            idempotencyKey: 'att',
          }),
        },
        {
          name: 'files',
          filename: 'q3.csv',
          contentType: 'text/csv',
          data: Buffer.from('a,b\n1,2\n'),
        },
      ]);
      const posted = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: form.body,
        headers: { 'content-type': form.contentType },
      });
      expect(posted.statusCode).toBe(200);
      const id = (posted.json() as { message: { attachments: { id: string }[] } }).message
        .attachments[0]?.id;
      expect(id).toBeDefined();

      const mine = await asAgent(alpha.key, { method: 'GET', url: `/api/agent/attachments/${id}` });
      expect(mine.statusCode).toBe(200);

      const theirs = await asAgent(beta.key, {
        method: 'GET',
        url: `/api/agent/attachments/${id}`,
      });
      expect(theirs.statusCode).toBe(404);
      expect(theirs.json()).toMatchObject({ code: 'not_found' });
    });

    it('answers an unrouted path in the same shape', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/api/agent/nothing-here' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found' });
    });
  });

  // -------------------------------------------------------------------------
  describe('untrusted content', () => {
    async function upload(filename: string, contentType: string): Promise<string> {
      const form = multipart([
        {
          name: 'request',
          value: JSON.stringify({
            target: { conversation },
            body: 'see attached',
            idempotencyKey: `k-${filename}`,
          }),
        },
        { name: 'files', filename, contentType, data: Buffer.from('<script>alert(1)</script>') },
      ]);
      const posted = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: form.body,
        headers: { 'content-type': form.contentType },
      });
      expect(posted.statusCode).toBe(200);
      const id = (posted.json() as { message: { attachments: { id: string }[] } }).message
        .attachments[0]?.id;
      expect(id).toBeDefined();
      return id as string;
    }

    it('never serves HTML or SVG inline', async () => {
      for (const [filename, declared] of [
        ['evil.html', 'text/html'],
        ['evil.svg', 'image/svg+xml'],
        ['evil.xml', 'application/xhtml+xml'],
      ] as const) {
        const id = await upload(filename, declared);
        const response = await asAgent(alpha.key, {
          method: 'GET',
          url: `/api/agent/attachments/${id}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('application/octet-stream');
        expect(response.headers['content-disposition']).toContain('attachment');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
      }
    });

    it('keeps an allowlisted type, still as a download', async () => {
      const id = await upload('notes.txt', 'text/plain; charset=utf-8');
      const response = await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/attachments/${id}`,
      });
      expect(response.headers['content-type']).toBe('text/plain');
      expect(response.headers['content-disposition']).toContain('attachment; filename="notes.txt"');
    });

    it('reduces a supplied filename to printable ASCII, keeping the original encoded', async () => {
      const id = await upload('rapport financier.csv', 'text/csv');
      const response = await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/attachments/${id}`,
      });
      const disposition = String(response.headers['content-disposition']);
      expect(disposition).toContain('filename="rapport financier.csv"');
      expect(disposition).toContain("filename*=UTF-8''rapport%20financier.csv");
    });

    it('never lets a filename carry quotes, separators or control characters', () => {
      // Not reachable through multipart, which strips the path itself. The
      // header is built defensively anyway: the store keeps whatever was sent.
      const built = contentDisposition('../../etc/pa"ss\u0001wd');
      expect(built).toContain('filename=".._.._etc_pa_ss_wd"');
      expect(built.split(';')[1]).not.toContain('/');
    });

    it('falls back to octet-stream for a type nobody allowlisted', () => {
      expect(safeContentType('text/html')).toBe('application/octet-stream');
      expect(safeContentType('image/svg+xml')).toBe('application/octet-stream');
      expect(safeContentType('TEXT/CSV; charset=utf-8')).toBe('text/csv');
    });

    it('serves the SPA under a strict Content-Security-Policy', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/' });
      const csp = String(response.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  // -------------------------------------------------------------------------
  describe('attachments upload as multipart', () => {
    it('writes the file before the message row, and both survive', async () => {
      const form = multipart([
        {
          name: 'request',
          value: JSON.stringify({ target: { conversation }, body: 'here', idempotencyKey: 'm1' }),
        },
        { name: 'files', filename: 'a.csv', contentType: 'text/csv', data: Buffer.from('x') },
      ]);
      const posted = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: form.body,
        headers: { 'content-type': form.contentType },
      });
      expect(posted.statusCode).toBe(200);
      expect(attachmentFiles(h)).toHaveLength(1);
      const attachment = (posted.json() as { message: { attachments: { sizeBytes: number }[] } })
        .message.attachments[0];
      expect(attachment?.sizeBytes).toBe(1);
    });

    it('refuses a file over maxAttachmentBytes and leaves nothing behind', async () => {
      const small = await harness({ DOGPARK_MAX_ATTACHMENT_BYTES: '16' });
      try {
        const agent = small.store.createAgent('uploader');
        const key = small.store.issueKey(agent.id).key;
        const s = small.store.createSpace('s').id;
        small.store.grantMembership(agent.id, s);
        const c = small.store.resolveOrCreateConversation(s, 't').id;

        const form = multipart([
          {
            name: 'request',
            value: JSON.stringify({
              target: { conversation: c },
              body: 'big',
              idempotencyKey: 'm2',
            }),
          },
          {
            name: 'files',
            filename: 'big.bin',
            contentType: 'application/octet-stream',
            data: Buffer.alloc(4096, 7),
          },
        ]);
        const posted = await small.app.inject({
          method: 'POST',
          url: '/api/agent/messages',
          payload: form.body,
          headers: { 'content-type': form.contentType, authorization: `Bearer ${key}` },
        });
        expect(posted.statusCode).toBe(413);
        expect(posted.json()).toMatchObject({ code: 'too_large' });
        expect(attachmentFiles(small)).toEqual([]);
        expect(small.store.readConversation({ kind: 'human' }, c).messages).toHaveLength(0);
      } finally {
        await teardown(small);
      }
    });

    it('rejects files that arrive before the request part', async () => {
      const form = multipart([
        { name: 'files', filename: 'early.csv', contentType: 'text/csv', data: Buffer.from('x') },
        {
          name: 'request',
          value: JSON.stringify({ target: { conversation }, body: 'late', idempotencyKey: 'm3' }),
        },
      ]);
      const posted = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: form.body,
        headers: { 'content-type': form.contentType },
      });
      expect(posted.statusCode).toBe(400);
      expect(attachmentFiles(h)).toEqual([]);
    });

    it('removes the files when the message is refused', async () => {
      const form = multipart([
        {
          name: 'request',
          value: JSON.stringify({
            target: { conversation },
            body: `bad${RESERVED_SEQUENCE}text`,
            idempotencyKey: 'm4',
          }),
        },
        { name: 'files', filename: 'a.csv', contentType: 'text/csv', data: Buffer.from('x') },
      ]);
      const posted = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: form.body,
        headers: { 'content-type': form.contentType },
      });
      expect(posted.statusCode).toBe(422);
      expect(posted.json()).toMatchObject({ code: 'reserved_sequence' });
      expect(attachmentFiles(h)).toEqual([]);
    });

    it('refuses a body over maxMessageBytes', async () => {
      const tiny = await harness({ DOGPARK_MAX_MESSAGE_BYTES: '32' });
      try {
        const agent = tiny.store.createAgent('wordy');
        const key = tiny.store.issueKey(agent.id).key;
        const s = tiny.store.createSpace('s').id;
        tiny.store.grantMembership(agent.id, s);
        const c = tiny.store.resolveOrCreateConversation(s, 't').id;
        const response = await tiny.app.inject({
          method: 'POST',
          url: '/api/agent/messages',
          headers: { authorization: `Bearer ${key}` },
          payload: { target: { conversation: c }, body: 'x'.repeat(100), idempotencyKey: 'm5' },
        });
        expect(response.statusCode).toBe(413);
        expect(response.json()).toMatchObject({ code: 'too_large' });
      } finally {
        await teardown(tiny);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('long polling', () => {
    /** Past the `space_access_granted` event a new member already has waiting. */
    const seekToTip = async (): Promise<string> => {
      const response = await asAgent(alpha.key, {
        method: 'GET',
        url: '/api/agent/stream?tip=true',
      });
      return (response.json() as { nextCursor: string }).nextCursor;
    };

    it('returns immediately when something is already waiting', async () => {
      await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: { target: { conversation }, body: 'already here', idempotencyKey: 'lp0' },
      });
      const started = Date.now();
      const response = await asAgent(alpha.key, {
        method: 'GET',
        url: '/api/agent/stream?waitSeconds=2',
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('waits, and is capped at maxWaitSeconds', async () => {
      const cursor = await seekToTip();
      const started = Date.now();
      const response = await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/stream?after=${encodeURIComponent(cursor)}&waitSeconds=600`,
      });
      const elapsed = Date.now() - started;
      expect(response.statusCode).toBe(200);
      expect((response.json() as { items: unknown[] }).items).toEqual([]);
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      expect(elapsed).toBeLessThan(6_000);
    });

    it('returns as soon as a write arrives', async () => {
      const cursor = await seekToTip();
      const started = Date.now();
      const waiting = asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/stream?after=${encodeURIComponent(cursor)}&waitSeconds=2`,
      });
      setTimeout(() => {
        void asAgent(alpha.key, {
          method: 'POST',
          url: '/api/agent/messages',
          payload: { target: { conversation }, body: 'late arrival', idempotencyKey: 'lp1' },
        });
      }, 50);

      const response = await waiting;
      expect(response.statusCode).toBe(200);
      expect((response.json() as { items: unknown[] }).items).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1_500);
    });

    it('returns without waiting when waitSeconds is absent', async () => {
      const started = Date.now();
      const response = await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream' });
      expect(response.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('refuses two ways of saying where to start', async () => {
      const response = await asAgent(alpha.key, {
        method: 'GET',
        url: '/api/agent/stream?tip=true&since=2026-01-01T00:00:00Z',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_request' });
    });
  });

  // -------------------------------------------------------------------------
  describe('the read log', () => {
    it('records a stream read with the parameters it was made with', async () => {
      await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream?tip=true' });
      const session = await login(h);
      const reads = await h.app.inject({
        method: 'GET',
        url: `/api/admin/reads?agent=${alpha.id}`,
        headers: { cookie: session.cookie },
      });
      const {
        reads: rows,
        nextCursor,
        hasMore,
      } = reads.json() as {
        reads: {
          agent: { id: string };
          at: string;
          kind: string;
          parameters: { from: { from: string } };
          cursor: string;
          itemCount: number;
        }[];
        nextCursor: string | null;
        hasMore: boolean;
      };
      expect(rows).toHaveLength(1);
      expect(nextCursor).toBeNull();
      expect(hasMore).toBe(false);
      expect(rows[0]?.agent.id).toBe(alpha.id);
      expect(rows[0]?.kind).toBe('stream');
      expect(rows[0]?.parameters.from).toEqual({ from: 'tip' });
      expect(rows[0]?.cursor).toEqual(expect.any(String));
    });

    it('honours a limit and reports whether more is waiting', async () => {
      await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream?tip=true' });
      await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream?tip=true' });
      const session = await login(h);
      const reads = await h.app.inject({
        method: 'GET',
        url: '/api/admin/reads?limit=1',
        headers: { cookie: session.cookie },
      });
      const body = reads.json() as { reads: unknown[]; hasMore: boolean };
      expect(body.reads).toHaveLength(1);
      expect(body.hasMore).toBe(true);
    });

    it('refuses a read-log filter the store cannot honour, rather than dropping it', async () => {
      const session = await login(h);
      for (const query of ['since=2020-01-01T00:00:00Z', 'until=2020-01-01T00:00:00Z', 'after=x']) {
        const response = await h.app.inject({
          method: 'GET',
          url: `/api/admin/reads?${query}`,
          headers: { cookie: session.cookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: 'invalid_request' });
      }
    });

    it('records a query read too, with its range', async () => {
      await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/spaces/${space}/messages?since=2020-01-01T00:00:00Z`,
      });
      const session = await login(h);
      const reads = await h.app.inject({
        method: 'GET',
        url: '/api/admin/reads',
        headers: { cookie: session.cookie },
      });
      const { reads: rows } = reads.json() as {
        reads: { kind: string; parameters: { range: { since: string } } }[];
      };
      expect(rows[0]?.kind).toBe('space');
      // As supplied, not as normalised: the log says what the agent asked for.
      expect(rows[0]?.parameters.range.since).toBe('2020-01-01T00:00:00Z');
    });
  });

  // -------------------------------------------------------------------------
  describe('the human session', () => {
    it('sets an HttpOnly, SameSite=Lax cookie and hands back a CSRF token', async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/admin/session',
        payload: { password: PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      const cookie = String(response.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect((response.json() as { csrfToken: string }).csrfToken).toEqual(expect.any(String));
    });

    it('marks the cookie Secure once a TLS-terminating proxy is declared', async () => {
      const proxied = await harness({ DOGPARK_TRUST_PROXY: '127.0.0.1' });
      try {
        const response = await proxied.app.inject({
          method: 'POST',
          url: '/api/admin/session',
          headers: { 'x-forwarded-proto': 'https' },
          payload: { password: PASSWORD },
        });
        expect(response.statusCode).toBe(200);
        expect(String(response.headers['set-cookie'])).toContain('Secure');
      } finally {
        await teardown(proxied);
      }
    });

    it('refuses the wrong password without saying more', async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/admin/session',
        payload: { password: 'not it' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'unauthenticated' });
    });

    it('invalidates the session server-side on logout', async () => {
      const session = await login(h);
      const before = await h.app.inject({
        method: 'GET',
        url: '/api/admin/spaces',
        headers: { cookie: session.cookie },
      });
      expect(before.statusCode).toBe(200);

      const out = await h.app.inject({
        method: 'DELETE',
        url: '/api/admin/session',
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      expect(out.statusCode).toBe(204);

      // The same cookie, replayed: the row is gone, so it is worth nothing.
      const after = await h.app.inject({
        method: 'GET',
        url: '/api/admin/spaces',
        headers: { cookie: session.cookie },
      });
      expect(after.statusCode).toBe(401);
    });

    it('resumes from the cookie alone, so a reload is not a new login', async () => {
      const session = await login(h);
      const resumed = await h.app.inject({
        method: 'GET',
        url: '/api/admin/session',
        headers: { cookie: session.cookie },
      });
      expect(resumed.statusCode).toBe(200);
      expect((resumed.json() as { csrfToken: string }).csrfToken).toBe(session.csrf);
    });
  });

  // -------------------------------------------------------------------------
  describe('CSRF', () => {
    it('refuses a state-changing admin request with no token', async () => {
      const session = await login(h);
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/admin/spaces',
        headers: { cookie: session.cookie },
        payload: { name: 'forged' },
      });
      expect(response.statusCode).toBe(403);
      expect(h.store.listSpaces().map((s) => s.name)).not.toContain('forged');
    });

    it('refuses a token that belongs to no session', async () => {
      const session = await login(h);
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/admin/spaces',
        headers: { cookie: session.cookie, 'x-csrf-token': 'made-up' },
        payload: { name: 'forged' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('lets a matching token through, and needs none on a read', async () => {
      const session = await login(h);
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/admin/spaces',
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        payload: { name: 'genuine' },
      });
      expect(created.statusCode).toBe(201);

      const read = await h.app.inject({
        method: 'GET',
        url: '/api/admin/spaces',
        headers: { cookie: session.cookie },
      });
      expect(read.statusCode).toBe(200);
    });

    it('answers an expired session with unauthenticated rather than a CSRF refusal', async () => {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/admin/spaces',
        headers: { cookie: 'dogpark_session=nonsense' },
        payload: { name: 'x' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('the admin API', () => {
    it('creates an agent and shows the key exactly once', async () => {
      const session = await login(h);
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/admin/agents',
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        payload: { name: 'gamma' },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as { agent: { id: string }; key: string; keyId: string };
      expect(body.key.startsWith(`dgp_${body.agent.id}_`)).toBe(true);

      const listed = await h.app.inject({
        method: 'GET',
        url: '/api/admin/agents',
        headers: { cookie: session.cookie },
      });
      expect(JSON.stringify(listed.json())).not.toContain(body.key);
      const rows = listed.json() as { id: string; hasEverAuthenticated: boolean }[];
      expect(rows.find((r) => r.id === body.agent.id)?.hasEverAuthenticated).toBe(false);
    });

    it('will not revoke a key through another agent', async () => {
      const session = await login(h);
      const issued = await h.app.inject({
        method: 'POST',
        url: `/api/admin/agents/${alpha.id}/keys`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        payload: {},
      });
      const { keyId } = issued.json() as { keyId: string };

      const wrongOwner = await h.app.inject({
        method: 'DELETE',
        url: `/api/admin/agents/${beta.id}/keys/${keyId}`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      expect(wrongOwner.statusCode).toBe(404);
      expect(h.store.listKeys(alpha.id).find((k) => k.id === keyId)?.revokedAt).toBeNull();

      const rightOwner = await h.app.inject({
        method: 'DELETE',
        url: `/api/admin/agents/${alpha.id}/keys/${keyId}`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      expect(rightOwner.statusCode).toBe(204);
    });

    it('archives away every key and unarchives with a fresh one', async () => {
      const session = await login(h);
      const archived = await h.app.inject({
        method: 'POST',
        url: `/api/admin/agents/${alpha.id}/archive`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      expect(archived.statusCode).toBe(200);

      const rejected = await asAgent(alpha.key, { method: 'GET', url: '/api/agent/identity' });
      expect(rejected.statusCode).toBe(401);

      const back = await h.app.inject({
        method: 'POST',
        url: `/api/admin/agents/${alpha.id}/unarchive`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      expect(back.statusCode).toBe(200);
      const fresh = (back.json() as { key: string }).key;
      const accepted = await asAgent(fresh, { method: 'GET', url: '/api/agent/identity' });
      expect(accepted.statusCode).toBe(200);
    });

    it('reports membership as current members and past intervals', async () => {
      const session = await login(h);
      await h.app.inject({
        method: 'PUT',
        url: `/api/admin/spaces/${space}/members/${beta.id}`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      await h.app.inject({
        method: 'DELETE',
        url: `/api/admin/spaces/${space}/members/${beta.id}`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });

      const members = await h.app.inject({
        method: 'GET',
        url: `/api/admin/spaces/${space}/members`,
        headers: { cookie: session.cookie },
      });
      const body = members.json() as {
        current: { agent: { id: string }; grantedAt: string }[];
        history: { agent: { id: string }; revokedAt: string }[];
      };
      expect(body.current.map((m) => m.agent.id)).toEqual([alpha.id]);
      expect(body.history.map((m) => m.agent.id)).toEqual([beta.id]);
      expect(body.history[0]?.revokedAt).toEqual(expect.any(String));
    });

    it('lists an agent\u2019s keys by id, and never their material', async () => {
      const session = await login(h);
      const keys = await h.app.inject({
        method: 'GET',
        url: `/api/admin/agents/${alpha.id}/keys`,
        headers: { cookie: session.cookie },
      });
      expect(keys.statusCode).toBe(200);
      const rows = keys.json() as { keyId: string; revokedAt: string | null }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.keyId).toEqual(expect.any(String));
      expect(JSON.stringify(rows)).not.toContain(alpha.key);

      const unknown = await h.app.inject({
        method: 'GET',
        url: '/api/admin/agents/0000000000000000/keys',
        headers: { cookie: session.cookie },
      });
      expect(unknown.statusCode).toBe(404);
    });

    it('refuses order=newest rather than answering with the oldest', async () => {
      const session = await login(h);
      const refused = await h.app.inject({
        method: 'GET',
        url: `/api/admin/conversations/${conversation}/messages?order=newest`,
        headers: { cookie: session.cookie },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'invalid_request' });

      const accepted = await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/conversations/${conversation}/messages?order=oldest`,
      });
      expect(accepted.statusCode).toBe(200);
    });

    it('404s a space that does not exist rather than answering emptily', async () => {
      const session = await login(h);
      const response = await h.app.inject({
        method: 'GET',
        url: '/api/admin/spaces/0000000000000000/members',
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(404);
    });

    it('posts as the human, and collapses a replayed idempotency key', async () => {
      const session = await login(h);
      const post = (): Promise<LightMyRequestResponse> =>
        h.app.inject({
          method: 'POST',
          url: '/api/admin/messages',
          headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
          payload: {
            target: { space, title: 'from the human' },
            body: 'you two coordinate',
            idempotencyKey: 'compose-1',
          },
        });
      const first = await post();
      const second = await post();
      expect(first.statusCode).toBe(200);
      const idOf = (r: LightMyRequestResponse): string =>
        (r.json() as { message: { id: string } }).message.id;
      expect(idOf(second)).toBe(idOf(first));
      expect(h.store.readSpace({ kind: 'human' }, space).messages).toHaveLength(1);
    });

    it('shows escalations with their notification state, and searches bodies', async () => {
      await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: { target: { conversation }, body: 'the figures are wrong', idempotencyKey: 'e0' },
      });
      const raised = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/escalations',
        payload: { conversation, reason: 'numbers look wrong', idempotencyKey: 'e1' },
      });
      expect(raised.statusCode).toBe(204);

      const session = await login(h);
      const inbox = await h.app.inject({
        method: 'GET',
        url: '/api/admin/escalations',
        headers: { cookie: session.cookie },
      });
      const rows = inbox.json() as {
        agent: { id: string };
        conversation: { id: string };
        raisedAt: string;
        notification: { state: string };
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent.id).toBe(alpha.id);
      expect(rows[0]?.conversation.id).toBe(conversation);
      expect(rows[0]?.notification.state).toBe('pending');

      const found = await h.app.inject({
        method: 'GET',
        url: '/api/admin/search?q=figures',
        headers: { cookie: session.cookie },
      });
      const hits = found.json() as { message: { body: string }; space: { id: string } }[];
      expect(hits).toHaveLength(1);
      expect(hits[0]?.space.id).toBe(space);
    });

    it('treats a malformed search query as a typo rather than a fault', async () => {
      const session = await login(h);
      const response = await h.app.inject({
        method: 'GET',
        url: '/api/admin/search?q=%22unbalanced',
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_request' });
    });
  });

  // -------------------------------------------------------------------------
  describe('the proxy declaration', () => {
    it('refuses a request the proxy says arrived over plaintext', async () => {
      const proxied = await harness({ DOGPARK_TRUST_PROXY: '127.0.0.1' });
      try {
        const response = await proxied.app.inject({
          method: 'GET',
          url: '/api/admin/spaces',
          headers: { 'x-forwarded-proto': 'http' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: 'invalid_request' });
      } finally {
        await teardown(proxied);
      }
    });

    it('ignores a forwarded protocol when no proxy is declared', async () => {
      const response = await h.app.inject({
        method: 'GET',
        url: '/api/agent/identity',
        headers: { 'x-forwarded-proto': 'http', authorization: `Bearer ${alpha.key}` },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  it('answers a health check', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
