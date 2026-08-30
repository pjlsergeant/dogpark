import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import type { Store } from '../store/index.js';
import { openStore, RESERVED_SEQUENCE } from '../store/index.js';
import type { AgentId, AttachmentId, ConversationId, SpaceId } from '../types.js';
import { buildApp } from './app.js';
import { contentDisposition, safeContentType, sweepUnreferenced } from './attachments.js';
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

/** `GET /reads` as it arrives on the wire, with only what the tests read. */
interface ReadLogBody {
  readonly reads: readonly { readonly id: string; readonly kind: string }[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** `MessagePage` as it arrives on the wire, with only what the tests read. */
interface MessagePageBody {
  readonly messages: readonly { readonly body: string }[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
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

    it('bounds failed authentication, which is free and unauthenticated otherwise', async () => {
      const attempt = (from: string): Promise<LightMyRequestResponse> =>
        h.app.inject({
          method: 'GET',
          url: '/api/agent/identity',
          headers: { authorization: `Bearer dgp_${alpha.id}_notthesecret` },
          remoteAddress: from,
        });

      const codes: number[] = [];
      for (let i = 0; i < 30; i += 1) codes.push((await attempt('10.0.0.1')).statusCode);

      // A bad key is always 401, never 429. Refusing before verification
      // cannot distinguish a flood from a valid key, so it would lock out
      // whoever the attacker chose to imitate or share a host with.
      expect(codes.every((c) => c === 401)).toBe(true);

      // What is bounded is the counter, because every agent id is public —
      // it is the middle of every key — so a stranger could otherwise drive it
      // up without limit and make a healthy agent look broken. It stops well
      // short of the number of attempts.
      const counted = h.store.getAgent(alpha.id)?.failedAuthAttempts ?? 0;
      expect(counted).toBeGreaterThan(0);
      expect(counted).toBeLessThan(codes.length);
    });

    it('never lets that flood shut out a key that verifies', async () => {
      for (let i = 0; i < 30; i += 1) {
        await h.app.inject({
          method: 'GET',
          url: '/api/agent/identity',
          headers: { authorization: `Bearer dgp_${alpha.id}_notthesecret` },
          remoteAddress: '10.0.0.1',
        });
      }

      // The flood spent both buckets — the address it came from and the id it
      // claimed. Neither may refuse anyone: the id is attacker-supplied, and
      // the address is shared by every agent on one host.
      const victim = await h.app.inject({
        method: 'GET',
        url: '/api/agent/identity',
        headers: { authorization: `Bearer ${alpha.key}` },
        remoteAddress: '10.0.0.2',
      });
      expect(victim.statusCode).toBe(200);

      const neighbour = await h.app.inject({
        method: 'GET',
        url: '/api/agent/identity',
        headers: { authorization: `Bearer ${beta.key}` },
        remoteAddress: '10.0.0.1',
      });
      expect(neighbour.statusCode).toBe(200);
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
  describe('bounded labels', () => {
    it('caps a title opened by a post target like a rename does', async () => {
      const over = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: {
          target: { space, title: 't'.repeat(201) },
          body: 'hello',
          idempotencyKey: 'cap-title',
        },
      });
      expect(over.statusCode).toBe(400);
      expect(over.json()).toMatchObject({ code: 'invalid_request' });
      expect((over.json() as { message: string }).message).toContain('title');

      const fits = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: {
          target: { space, title: 't'.repeat(200) },
          body: 'hello',
          idempotencyKey: 'cap-title-ok',
        },
      });
      expect(fits.statusCode).toBe(200);
    });

    it('caps an escalation reason', async () => {
      const over = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/escalations',
        payload: { conversation, reason: 'r'.repeat(2001), idempotencyKey: 'cap-reason' },
      });
      expect(over.statusCode).toBe(400);
      expect((over.json() as { message: string }).message).toContain('reason');
    });
  });

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

    it('tells two files of the same name, type and size apart on a retry', async () => {
      const upload = (bytes: string): Promise<LightMyRequestResponse> => {
        const form = multipart([
          {
            name: 'request',
            value: JSON.stringify({ target: { conversation }, body: 'here', idempotencyKey: 'd1' }),
          },
          {
            name: 'files',
            filename: 'report.csv',
            contentType: 'text/csv',
            data: Buffer.from(bytes),
          },
        ]);
        return asAgent(alpha.key, {
          method: 'POST',
          url: '/api/agent/messages',
          payload: form.body,
          headers: { 'content-type': form.contentType },
        });
      };

      const first = await upload('x');
      expect(first.statusCode).toBe(200);
      const idOf = (r: LightMyRequestResponse): string =>
        (r.json() as { message: { id: string } }).message.id;

      // The same file again is the same request: a replay, and the bytes just
      // written belong to no message, so they are not left behind.
      const retry = await upload('x');
      expect(retry.statusCode).toBe(200);
      expect(idOf(retry)).toBe(idOf(first));
      expect(attachmentFiles(h)).toHaveLength(1);

      // A different file of the same name, type and size is a different
      // request. Without a digest of the bytes nothing here can tell, and this
      // replays the first message — quietly answering with the wrong file.
      const different = await upload('y');
      expect(different.statusCode).toBe(400);
      expect(different.json()).toMatchObject({ code: 'invalid_request' });
      expect(attachmentFiles(h)).toHaveLength(1);
    });

    it('does the same for the human, whose idempotency is the HTTP layer\u2019s', async () => {
      const session = await login(h);
      const upload = (bytes: string): Promise<LightMyRequestResponse> => {
        const form = multipart([
          {
            name: 'request',
            value: JSON.stringify({ target: { conversation }, body: 'here', idempotencyKey: 'h1' }),
          },
          {
            name: 'files',
            filename: 'report.csv',
            contentType: 'text/csv',
            data: Buffer.from(bytes),
          },
        ]);
        return h.app.inject({
          method: 'POST',
          url: '/api/admin/messages',
          payload: form.body,
          headers: {
            'content-type': form.contentType,
            cookie: session.cookie,
            'x-csrf-token': session.csrf,
          },
        });
      };

      expect((await upload('x')).statusCode).toBe(200);
      const different = await upload('y');
      expect(different.statusCode).toBe(400);
      expect(different.json()).toMatchObject({ code: 'invalid_request' });
    });

    it('collects a file no message references, and keeps one that is', async () => {
      const form = multipart([
        {
          name: 'request',
          value: JSON.stringify({ target: { conversation }, body: 'kept', idempotencyKey: 's1' }),
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

      // What a crash between the file write and the message commit leaves: the
      // bytes are on the volume and nothing points at them.
      const stray = 'deadbeefdeadbeef';
      const root = join(h.dir, 'attachments');
      mkdirSync(join(root, stray.slice(0, 2)), { recursive: true });
      writeFileSync(join(root, stray.slice(0, 2), stray), 'orphaned');
      expect(attachmentFiles(h)).toHaveLength(2);

      const swept = await sweepUnreferenced(
        root,
        (id) => h.store.getAttachment(id as AttachmentId) !== undefined,
        { minimumAgeMs: 0 },
      );
      expect(swept).toEqual([stray]);
      expect(attachmentFiles(h)).toHaveLength(1);
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
      // A real position, not a placeholder: the log is resumable.
      expect(nextCursor).toEqual(expect.any(String));
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

    it('pages the log with the cursor it handed back, oldest continuing after newest', async () => {
      await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream?tip=true' });
      await asAgent(alpha.key, { method: 'GET', url: `/api/agent/spaces/${space}/messages` });
      const session = await login(h);
      const reads = async (query: string): Promise<ReadLogBody> => {
        const response = await h.app.inject({
          method: 'GET',
          url: `/api/admin/reads?${query}`,
          headers: { cookie: session.cookie },
        });
        expect(response.statusCode).toBe(200);
        return response.json() as ReadLogBody;
      };

      // Newest first, so the space read comes before the stream read that
      // preceded it.
      const first = await reads('limit=1');
      expect(first.reads.map((r) => r.kind)).toEqual(['space']);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toEqual(expect.any(String));

      const next = await reads(`limit=1&after=${encodeURIComponent(first.nextCursor ?? '')}`);
      expect(next.reads.map((r) => r.kind)).toEqual(['stream']);
      expect(next.hasMore).toBe(false);
      // Continuing strictly older: the page it already had is not repeated.
      expect(next.reads[0]?.id).not.toBe(first.reads[0]?.id);
    });

    it('bounds the log by since and until, which are what a forensic view asks', async () => {
      await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream?tip=true' });
      const session = await login(h);
      const reads = async (query: string): Promise<ReadLogBody> => {
        const response = await h.app.inject({
          method: 'GET',
          url: `/api/admin/reads?${query}`,
          headers: { cookie: session.cookie },
        });
        expect(response.statusCode).toBe(200);
        return response.json() as ReadLogBody;
      };

      expect((await reads('since=2020-01-01T00:00:00Z')).reads).toHaveLength(1);
      // `until` is exclusive and bounds when the read happened, so a window
      // that closed before this process started holds nothing.
      expect((await reads('until=2020-01-01T00:00:00Z')).reads).toEqual([]);
      expect((await reads('since=2999-01-01T00:00:00Z')).reads).toEqual([]);
    });

    it('refuses a filter it cannot read, rather than answering as if it were absent', async () => {
      const session = await login(h);
      for (const query of ['since=the-day-before-yesterday', 'after=not-a-cursor']) {
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

    it('reads a thread backwards from the newest, and pages older with after', async () => {
      for (const body of ['one', 'two', 'three']) {
        h.store.postMessage({ sender: { kind: 'human' }, target: { conversation }, body });
      }
      const session = await login(h);
      const backwards = (after?: string): Promise<LightMyRequestResponse> =>
        h.app.inject({
          method: 'GET',
          url:
            `/api/admin/conversations/${conversation}/messages?order=newest&limit=2` +
            (after === undefined ? '' : `&after=${encodeURIComponent(after)}`),
          headers: { cookie: session.cookie },
        });

      const first = await backwards();
      expect(first.statusCode).toBe(200);
      const page = first.json() as MessagePageBody;
      // Newest first, which is the whole point: the last thing said is the
      // first thing read.
      expect(page.messages.map((m) => m.body)).toEqual(['three', 'two']);
      expect(page.hasMore).toBe(true);

      const older = (await backwards(page.nextCursor)).json() as MessagePageBody;
      expect(older.messages.map((m) => m.body)).toEqual(['one']);
      expect(older.hasMore).toBe(false);

      // The same range read forwards is the same messages, the other way up.
      const forwards = await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/conversations/${conversation}/messages?order=oldest`,
      });
      expect(forwards.statusCode).toBe(200);
      expect((forwards.json() as MessagePageBody).messages.map((m) => m.body)).toEqual([
        'one',
        'two',
        'three',
      ]);

      // And an agent gets it too, since it is the reader the ordering exists
      // for: fifty messages of recent context without walking from day one.
      const agentPage = await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/conversations/${conversation}/messages?order=newest&limit=1`,
      });
      expect((agentPage.json() as MessagePageBody).messages.map((m) => m.body)).toEqual(['three']);
    });

    it('renames a thread, and refuses a title already used in that space', async () => {
      const session = await login(h);
      const renamed = await h.app.inject({
        method: 'PATCH',
        url: `/api/admin/conversations/${conversation}`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        payload: { title: 'the weekly figures' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ id: conversation, title: 'the weekly figures' });

      // Titles address a thread (ADR-0012), so two threads in one space cannot
      // share one. A clash is invalid_request like every other name clash;
      // the wire vocabulary has no separate conflict code.
      const taken = h.store.resolveOrCreateConversation(space, 'something else').id;
      const clash = await h.app.inject({
        method: 'PATCH',
        url: `/api/admin/conversations/${taken}`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        payload: { title: 'the weekly figures' },
      });
      expect(clash.statusCode).toBe(400);
    });

    it('carries a count, the last activity and the last sender in the thread list', async () => {
      await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: { target: { conversation }, body: 'the figures', idempotencyKey: 'tl-1' },
      });
      const quiet = h.store.resolveOrCreateConversation(space, 'nobody has posted here').id;

      const session = await login(h);
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/admin/spaces/${space}/conversations`,
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(200);
      const threads = response.json() as {
        id: string;
        title: string;
        messageCount: number;
        lastActivityAt: string | null;
        lastSender: { kind: string; displayName: string } | null;
      }[];

      const busy = threads.find((t) => t.id === conversation);
      expect(busy?.messageCount).toBe(1);
      expect(busy?.lastActivityAt).toEqual(expect.any(String));
      // The whole Sender, not a name: the UI renders an agent's current name
      // rather than one frozen when the message was written.
      expect(busy?.lastSender).toMatchObject({ kind: 'agent', displayName: 'alpha' });

      // A thread nobody has posted to is still a thread, and says so rather
      // than being left out of the list.
      const empty = threads.find((t) => t.id === quiet);
      expect(empty?.messageCount).toBe(0);
      expect(empty?.lastActivityAt).toBeNull();
      expect(empty?.lastSender).toBeNull();
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

    it('disbelieves X-Forwarded-Proto: https from an address that is not the proxy', async () => {
      // The trust list governs what Fastify derives, never the raw header. A
      // direct caller that forges the header must still read as plaintext.
      const proxied = await harness({ DOGPARK_TRUST_PROXY: '127.0.0.1' });
      try {
        const agent = proxied.store.createAgent('gamma');
        const key = proxied.store.issueKey(agent.id).key;
        const forged = await proxied.app.inject({
          method: 'GET',
          url: '/api/agent/identity',
          remoteAddress: '10.0.0.9',
          headers: { 'x-forwarded-proto': 'https', authorization: `Bearer ${key}` },
        });
        expect(forged.statusCode).toBe(400);
        expect(forged.json()).toMatchObject({ code: 'invalid_request' });

        const honest = await proxied.app.inject({
          method: 'GET',
          url: '/api/agent/identity',
          remoteAddress: '127.0.0.1',
          headers: { 'x-forwarded-proto': 'https', authorization: `Bearer ${key}` },
        });
        expect(honest.statusCode).toBe(200);
      } finally {
        await teardown(proxied);
      }
    });

    it('proves TLS on a percent-encoded spelling of an API path too', async () => {
      // The router decodes before matching, so `/%61pi/` reaches the API; the
      // proof has to follow the route, not the raw string.
      const proxied = await harness({ DOGPARK_TRUST_PROXY: '127.0.0.1' });
      try {
        const agent = proxied.store.createAgent('gamma');
        const key = proxied.store.issueKey(agent.id).key;
        const canonical = await proxied.app.inject({
          method: 'GET',
          url: '/api/agent/identity',
          headers: { authorization: `Bearer ${key}` },
        });
        expect(canonical.statusCode).toBe(400);

        const encoded = await proxied.app.inject({
          method: 'GET',
          url: '/%61pi/agent/identity',
          headers: { authorization: `Bearer ${key}` },
        });
        expect(encoded.statusCode).toBe(400);
        expect(encoded.json()).toMatchObject({ code: 'invalid_request' });
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
