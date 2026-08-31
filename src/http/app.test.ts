import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import type { Store } from '../store/index.js';
import { openStore, RESERVED_SEQUENCE } from '../store/index.js';
import type { AgentId, AttachmentId, ConversationId, SpaceId, Timestamp } from '../types.js';
import {
  AdminAgentSchema,
  ChangesResponseSchema,
  ConversationSchema,
  ConversationSummarySchema,
  HumanCatchUpPageSchema,
  ExportDocumentSchema,
  EscalationSchema,
  EscalationsResponseSchema,
  IdentitySchema,
  IssuedKeySchema,
  MessagePageSchema,
  PostResultSchema,
  ReadLogEntrySchema,
  ReadLogPageSchema,
  SearchResponseSchema,
  SessionCredentialsSchema,
  SpaceSummarySchema,
  SpaceMembersSchema,
  StreamPageSchema,
} from '../types.js';
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

interface EscalationsBody {
  escalations: { id: string; reason: string; acknowledgedAt: string | null }[];
  nextCursor: string | null;
  hasMore: boolean;
  unacknowledged: number;
  undelivered: number;
  webhookConfigured: boolean;
}

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
      const body = IdentitySchema.parse(response.json());
      expect(body.self.id).toBe(alpha.id);
      expect(body.spaces.map((s) => s.id)).toEqual([space]);
      expect(body.limits.maxWaitSeconds).toBe(2);
      expect(body.reservedSequence).toBe(RESERVED_SEQUENCE);
    });

    it('serves descriptions and membership notes only on orientation endpoints', async () => {
      h.store.setSpaceDescription(space, 'Space purpose');
      h.store.setAgentDescription(alpha.id, 'Coordinator');
      h.store.setAgentDescription(beta.id, 'Reviewer');
      h.store.setMembershipNote(alpha.id, space, 'Own reason');
      h.store.grantMembership(beta.id, space);
      h.store.setMembershipNote(beta.id, space, 'Peer reason');

      const identity = IdentitySchema.parse(
        (await asAgent(alpha.key, { method: 'GET', url: '/api/agent/identity' })).json(),
      );
      expect(identity.spaces[0]).toMatchObject({
        description: 'Space purpose',
        note: 'Own reason',
      });
      expect(identity.limits.maxDescriptionChars).toBe(1000);

      const peers = (
        await asAgent(alpha.key, {
          method: 'GET',
          url: `/api/agent/agents?space=${space}`,
        })
      ).json() as { id: string; description?: string; note?: string }[];
      expect(peers.find((peer) => peer.id === beta.id)).toMatchObject({
        description: 'Reviewer',
        note: 'Peer reason',
      });
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

    it('refuses more than twenty files on one message as too_large, as the guide says', async () => {
      const files = Array.from({ length: 21 }, (_, i) => ({
        name: 'files',
        filename: `part-${i}.txt`,
        contentType: 'text/plain',
        data: Buffer.from(`part ${i}`),
      }));
      const form = multipart([
        {
          name: 'request',
          value: JSON.stringify({
            target: { conversation },
            body: 'too many',
            idempotencyKey: 'twenty-one',
          }),
        },
        ...files,
      ]);
      const response = await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/messages',
        payload: form.body,
        headers: { 'content-type': form.contentType },
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ code: 'too_large' });
      expect(attachmentFiles(h)).toEqual([]);
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

      // The fetch that served bytes is a read and was logged; the refused one
      // and the human's are not.
      const session = await login(h);
      await h.app.inject({
        method: 'GET',
        url: `/api/admin/attachments/${id}`,
        headers: { cookie: session.cookie },
      });
      const reads = await h.app.inject({
        method: 'GET',
        url: '/api/admin/reads',
        headers: { cookie: session.cookie },
      });
      const rows = (
        reads.json() as {
          reads: { agent: { id: string }; kind: string; parameters: Record<string, unknown> }[];
        }
      ).reads.filter((r) => r.kind === 'attachment');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent.id).toBe(alpha.id);
      expect(rows[0]?.parameters).toEqual({ attachment: id, message: expect.any(String) });
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

    it('does the same for the human, whose key is scoped in the store like an agent\u2019s', async () => {
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

    it('collects a file written in the same millisecond as the sweep', async () => {
      // Filesystem timestamps are finer than Date.now(): a file stamped half
      // a millisecond after `now` is not "in flight", it is a rounding artefact.
      const stray = 'cafef00dcafef00d';
      const root = join(h.dir, 'attachments');
      mkdirSync(join(root, stray.slice(0, 2)), { recursive: true });
      const path = join(root, stray.slice(0, 2), stray);
      writeFileSync(path, 'orphaned');
      const now = Math.floor((await stat(path)).mtimeMs);
      utimesSync(path, (now + 0.5) / 1000, (now + 0.5) / 1000);

      const swept = await sweepUnreferenced(root, () => false, { now, minimumAgeMs: 0 });
      expect(swept).toEqual([stray]);
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
      expect(StreamPageSchema.parse(response.json()).items.length).toBeGreaterThan(0);
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

    it('records both reads of a long poll, and the hint is the second', async () => {
      // Each read commits its row before its response is sent — the first
      // before the wait, the second before the page goes out. The hint is
      // therefore at-most-once: a response lost in transit is still logged as
      // handed over, and resuming from the hint skips it (docs/running.md).
      const cursor = await seekToTip();
      const session = await login(h);
      const countReads = async (): Promise<{ kind: string; cursor: string }[]> => {
        const reads = await h.app.inject({
          method: 'GET',
          url: `/api/admin/reads?agent=${alpha.id}`,
          headers: { cookie: session.cookie },
        });
        return (reads.json() as { reads: { kind: string; cursor: string }[] }).reads;
      };
      const before = (await countReads()).length;

      const waiting = asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/stream?after=${encodeURIComponent(cursor)}&waitSeconds=2`,
      });
      setTimeout(() => {
        void asAgent(alpha.key, {
          method: 'POST',
          url: '/api/agent/messages',
          payload: { target: { conversation }, body: 'late', idempotencyKey: 'lp2' },
        });
      }, 50);
      const response = await waiting;
      const page = response.json() as { items: unknown[]; nextCursor: string };
      expect(page.items).toHaveLength(1);

      const after = await countReads();
      expect(after.length).toBe(before + 2);
      expect(after[0]?.cursor).toBe(page.nextCursor);
      expect(after[1]?.cursor).toBe(cursor);

      const identity = await asAgent(alpha.key, { method: 'GET', url: '/api/agent/identity' });
      expect((identity.json() as { lastReadCursor: string }).lastReadCursor).toBe(page.nextCursor);
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

    it('refuses a falsy tip instead of silently reading from the beginning', async () => {
      // `tip=0` used to be dropped as falsy: alone it read the whole history,
      // and beside `after` it slipped past the one-start-only check. Both
      // answered a question nobody asked.
      const alone = await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream?tip=0' });
      expect(alone.statusCode).toBe(400);
      expect((alone.json() as { message: string }).message).toContain('tip is a flag');

      const cursor = (
        (await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream?tip=1' })).json() as {
          nextCursor: string;
        }
      ).nextCursor;
      const beside = await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/stream?after=${encodeURIComponent(cursor)}&tip=false`,
      });
      expect(beside.statusCode).toBe(400);
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
      const { reads: rows, nextCursor, hasMore } = ReadLogPageSchema.parse(reads.json());
      expect(rows).toHaveLength(1);
      // A real position, not a placeholder: the log is resumable.
      expect(nextCursor).toEqual(expect.any(String));
      expect(hasMore).toBe(false);
      expect(rows[0]?.agent.id).toBe(alpha.id);
      expect(rows[0]?.kind).toBe('stream');
      expect(rows[0]?.parameters.from).toEqual({ from: 'tip' });
      expect(rows[0]?.cursor).toEqual(expect.any(String));
    });

    it('says what a collapsed row stands for, and says nothing on an ordinary one', async () => {
      // Two polls resuming from one another, then aged past the cutoff.
      const first = await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream?tip=true' });
      const cursor = (first.json() as { nextCursor: string }).nextCursor;
      await asAgent(alpha.key, {
        method: 'GET',
        url: `/api/agent/stream?after=${encodeURIComponent(cursor)}`,
      });
      const session = await login(h);
      const rows = async (): Promise<Record<string, unknown>[]> => {
        const response = await h.app.inject({
          method: 'GET',
          url: `/api/admin/reads?agent=${alpha.id}`,
          headers: { cookie: session.cookie },
        });
        return (response.json() as { reads: Record<string, unknown>[] }).reads;
      };

      for (const row of await rows()) {
        expect(row).not.toHaveProperty('collapsedCount');
        expect(row).not.toHaveProperty('firstReadAt');
      }

      const later = new Date(Date.now() + 60_000).toISOString() as Timestamp;
      expect(h.store.collapseEmptyStreamReads(later).removed).toBe(1);
      const collapsed = await rows();
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0]?.['collapsedCount']).toBe(2);
      expect(collapsed[0]?.['firstReadAt']).toEqual(expect.any(String));
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

    it('renders a thread as it read at the time of a given row', async () => {
      const session = await login(h);
      h.store.postMessage({
        sender: { kind: 'human' },
        target: { conversation },
        body: 'the figures',
      });
      const handed = (
        await asAgent(alpha.key, {
          method: 'GET',
          url: `/api/agent/conversations/${conversation}/messages`,
        }).then((r) => r.json() as { messages: { id: string; conversationTitle: string }[] })
      ).messages[0];
      const row = (
        (
          await h.app.inject({
            method: 'GET',
            url: `/api/admin/reads?agent=${alpha.id}&limit=1`,
            headers: { cookie: session.cookie },
          })
        ).json() as { reads: { id: string }[] }
      ).reads[0];
      await h.app.inject({
        method: 'PATCH',
        url: `/api/admin/conversations/${conversation}`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        payload: { title: 'renamed since' },
      });

      // The whole thread as of that read, and the row itself with its
      // conversation resolved so the reader can be linked to.
      const asOf = await h.app.inject({
        method: 'GET',
        url: `/api/admin/reads/${row?.id ?? ''}/conversations/${conversation}/messages`,
        headers: { cookie: session.cookie },
      });
      expect(asOf.statusCode).toBe(200);
      expect(MessagePageSchema.parse(asOf.json()).messages[0]?.conversationTitle).toBe(
        handed?.conversationTitle,
      );
      const one = await h.app.inject({
        method: 'GET',
        url: `/api/admin/reads/${row?.id ?? ''}`,
        headers: { cookie: session.cookie },
      });
      expect(ReadLogEntrySchema.parse(one.json())).toMatchObject({
        kind: 'conversation',
        conversation: { id: conversation, space, title: 'renamed since' },
      });
      expect(
        (
          await h.app.inject({
            method: 'GET',
            url: `/api/admin/reads/nope/conversations/${conversation}/messages`,
            headers: { cookie: session.cookie },
          })
        ).statusCode,
      ).toBe(404);
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
      expect(SessionCredentialsSchema.parse(response.json()).csrfToken).toEqual(expect.any(String));
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
    describe('exports', () => {
      it('exports a conversation as rendered markdown and structured JSON without logging a read', async () => {
        h.store.grantMembership(beta.id, space);
        const posted = h.store.postMessage({
          sender: { kind: 'agent', id: alpha.id },
          target: { conversation },
          body: 'hello @beta',
        });
        h.store.pinMessage({ kind: 'human' }, conversation, posted.message.id);
        h.store.completeConversation({ kind: 'human' }, conversation);
        h.store.renameAgent(beta.id, 'renamed-beta');
        const session = await login(h);

        const markdown = await h.app.inject({
          method: 'GET',
          url: `/api/admin/conversations/${conversation}/export?format=markdown`,
          headers: { cookie: session.cookie },
        });
        expect(markdown.statusCode).toBe(200);
        expect(markdown.headers['content-disposition']).toContain('.md');
        expect(markdown.body).toContain('# 2027 budget');
        expect(markdown.body).toContain('@renamed-beta');
        expect(markdown.body).toContain('complete');
        expect(markdown.body).toContain(h.config.DOGPARK_DISPLAY_NAME);

        const json = await h.app.inject({
          method: 'GET',
          url: `/api/admin/conversations/${conversation}/export?format=json`,
          headers: { cookie: session.cookie },
        });
        expect(json.statusCode).toBe(200);
        expect(json.headers['content-disposition']).toContain('.json');
        expect(json.headers['content-type']).toContain('application/json');
        expect(ExportDocumentSchema.parse(json.json())).toMatchObject({
          space: { id: space, name: 'money-and-life' },
          conversations: [
            {
              conversation: { id: conversation, title: '2027 budget' },
              annotations: { status: 'complete' },
              messages: [{ body: 'hello @renamed-beta' }],
            },
          ],
        });

        const reads = await h.app.inject({
          method: 'GET',
          url: '/api/admin/reads',
          headers: { cookie: session.cookie },
        });
        expect((reads.json() as ReadLogBody).reads).toEqual([]);
      });

      it('exports a message committed in the same millisecond the export begins', async () => {
        // The snapshot bound is a seq, not the clock: with time frozen, a
        // timestamp bound would have to choose between dropping this message
        // and admitting writes that land during the export.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-01T09:00:00.000Z'));
        try {
          const session = await login(h);
          h.store.postMessage({
            sender: { kind: 'agent', id: alpha.id },
            target: { conversation },
            body: 'committed just before the export',
          });
          const json = await h.app.inject({
            method: 'GET',
            url: `/api/admin/conversations/${conversation}/export?format=json`,
            headers: { cookie: session.cookie },
          });
          expect(json.statusCode).toBe(200);
          const document = ExportDocumentSchema.parse(json.json());
          expect(document.conversations[0]?.messages.map((m) => m.body)).toContain(
            'committed just before the export',
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it('streams a space bundle with sanitized attachment paths and tolerates missing bytes', async () => {
        const request = multipart([
          {
            name: 'request',
            value: JSON.stringify({ target: { conversation }, body: 'files', idempotencyKey: 'x' }),
          },
          {
            name: 'file',
            filename: '../notes.txt',
            contentType: 'text/plain',
            data: Buffer.from('bundle payload'),
          },
          {
            name: 'file',
            filename: 'report](evil.md',
            contentType: 'text/plain',
            data: Buffer.from('hostile name'),
          },
        ]);
        const posted = await asAgent(alpha.key, {
          method: 'POST',
          url: '/api/agent/messages',
          headers: { 'content-type': request.contentType },
          payload: request.body,
        });
        // Two files went up; the response lists attachments in id order, which
        // is random, so pick by name.
        const attachment = (
          posted.json() as { message: { attachments: { id: string; filename: string }[] } }
        ).message.attachments.find((a) => a.filename === 'notes.txt');
        expect(attachment).toBeDefined();
        h.store.setSpaceDescription(space, '# Status: fine');
        const session = await login(h);

        const bundle = await h.app.inject({
          method: 'GET',
          url: `/api/admin/spaces/${space}/export?format=bundle`,
          headers: { cookie: session.cookie },
        });
        expect(bundle.statusCode).toBe(200);
        expect(bundle.headers['content-type']).toContain('application/zip');
        expect(bundle.rawPayload.subarray(0, 2).toString()).toBe('PK');
        expect(
          bundle.rawPayload.includes(Buffer.from(`attachments/${attachment?.id}/notes.txt`)),
        ).toBe(true);
        expect(bundle.rawPayload.includes(Buffer.from('bundle payload'))).toBe(true);

        // The space description is plain text on its own line: never a heading.
        const spaceMarkdown = await h.app.inject({
          method: 'GET',
          url: `/api/admin/spaces/${space}/export?format=markdown`,
          headers: { cookie: session.cookie },
        });
        expect(spaceMarkdown.body).not.toMatch(/^# Status: fine/m);
        expect(spaceMarkdown.body).toContain('\\# Status: fine');
        // Nor a list item or a rule: the markers that work at column 0.
        for (const [description, escaped] of [
          ['- TODO', '\\- TODO'],
          ['1. on-call', '1\\. on-call'],
          ['---', '\\---'],
        ] as const) {
          h.store.setSpaceDescription(space, description);
          const again = await h.app.inject({
            method: 'GET',
            url: `/api/admin/spaces/${space}/export?format=markdown`,
            headers: { cookie: session.cookie },
          });
          expect(again.body).toContain(`\n${escaped}\n`);
        }

        // A filename is display text inside generated markdown, never structure.
        const markdown = await h.app.inject({
          method: 'GET',
          url: `/api/admin/conversations/${conversation}/export?format=markdown`,
          headers: { cookie: session.cookie },
        });
        expect(markdown.body).not.toContain('](evil.md');
        expect(markdown.body).toContain('report\\]\\(evil.md');

        // A title's newline is not a line break in the export: block constructs
        // need a line start, and a heading is one line.
        h.store.renameConversation(conversation, 'Quarterly\n\n- injected item');
        const retitled = await h.app.inject({
          method: 'GET',
          url: `/api/admin/conversations/${conversation}/export?format=markdown`,
          headers: { cookie: session.cookie },
        });
        expect(retitled.body).not.toMatch(/^- injected item/m);
        expect(retitled.body).toContain('# Quarterly - injected item');

        // Only line breaks are touched: a doubled space is part of the title.
        h.store.renameConversation(conversation, 'Quarterly  report');
        const spaced = await h.app.inject({
          method: 'GET',
          url: `/api/admin/conversations/${conversation}/export?format=markdown`,
          headers: { cookie: session.cookie },
        });
        expect(spaced.body).toContain('# Quarterly  report');

        rmSync(join(h.dir, 'attachments'), { recursive: true, force: true });
        const missing = await h.app.inject({
          method: 'GET',
          url: `/api/admin/conversations/${conversation}/export?format=markdown`,
          headers: { cookie: session.cookie },
        });
        expect(missing.statusCode).toBe(200);
        expect(missing.body).toContain('missing from storage');
      });

      it('keeps the stream sequence off every agent response', async () => {
        // A deployment-wide counter in an agent's hands measures activity
        // behind the visibility boundary; only the admin surfaces carry it.
        await asAgent(alpha.key, {
          method: 'POST',
          url: '/api/agent/messages',
          payload: { target: { conversation }, body: 'sequenced', idempotencyKey: 'seq-1' },
        });
        const read = (
          await asAgent(alpha.key, {
            method: 'GET',
            url: `/api/agent/conversations/${conversation}/messages`,
          })
        ).json() as { messages: Record<string, unknown>[] };
        expect(read.messages.length).toBeGreaterThan(0);
        for (const message of read.messages) expect(message).not.toHaveProperty('seq');
        const stream = (
          await asAgent(alpha.key, { method: 'GET', url: '/api/agent/stream' })
        ).json() as {
          items: Record<string, unknown>[];
        };
        expect(stream.items.some((item) => item['kind'] === 'message')).toBe(true);
        for (const item of stream.items) expect(item).not.toHaveProperty('seq');
        const posted = (
          await asAgent(alpha.key, {
            method: 'POST',
            url: '/api/agent/messages',
            payload: { target: { conversation }, body: 'sequenced again', idempotencyKey: 'seq-2' },
          })
        ).json() as { message: Record<string, unknown> };
        expect(posted.message).not.toHaveProperty('seq');
        const spacePage = (
          await asAgent(alpha.key, { method: 'GET', url: `/api/agent/spaces/${space}/messages` })
        ).json() as { messages: Record<string, unknown>[] };
        expect(spacePage.messages.length).toBeGreaterThan(0);
        for (const message of spacePage.messages) expect(message).not.toHaveProperty('seq');

        const session = await login(h);
        const admin = (
          await h.app.inject({
            method: 'GET',
            url: `/api/admin/conversations/${conversation}/messages`,
            headers: { cookie: session.cookie },
          })
        ).json() as { messages: { seq?: number }[] };
        expect(admin.messages.every((message) => typeof message.seq === 'number')).toBe(true);
      });

      it('requires an admin session and rejects unknown export formats', async () => {
        expect(
          (
            await h.app.inject({
              method: 'GET',
              url: `/api/admin/conversations/${conversation}/export?format=json`,
            })
          ).statusCode,
        ).toBe(401);
        const session = await login(h);
        expect(
          (
            await h.app.inject({
              method: 'GET',
              url: `/api/admin/conversations/${conversation}/export?format=pdf`,
              headers: { cookie: session.cookie },
            })
          ).statusCode,
        ).toBe(400);
      });
    });

    it('sets descriptions with session and CSRF and includes them in lists', async () => {
      const session = await login(h);
      const put = (url: string, description: string): Promise<LightMyRequestResponse> =>
        h.app.inject({
          method: 'PUT',
          url,
          headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
          payload: { description },
        });
      expect(
        (await put(`/api/admin/spaces/${space}/description`, 'Space purpose')).statusCode,
      ).toBe(204);
      expect(
        (await put(`/api/admin/agents/${alpha.id}/description`, 'Coordinator')).statusCode,
      ).toBe(204);
      expect(
        (await put(`/api/admin/spaces/${space}/members/${alpha.id}/note`, 'Why here')).statusCode,
      ).toBe(204);

      expect(
        (
          await h.app.inject({
            method: 'GET',
            url: '/api/admin/spaces',
            headers: { cookie: session.cookie },
          })
        ).json()[0],
      ).toMatchObject({ description: 'Space purpose' });
      expect(
        (
          await h.app.inject({
            method: 'GET',
            url: '/api/admin/agents',
            headers: { cookie: session.cookie },
          })
        )
          .json()
          .find((row: { id: string }) => row.id === alpha.id),
      ).toMatchObject({ description: 'Coordinator' });

      h.store.revokeMembership(alpha.id, space);
      const closed = await put(`/api/admin/spaces/${space}/members/${alpha.id}/note`, 'late');
      expect(closed.statusCode).toBe(400);
      expect(closed.json()).toMatchObject({ code: 'invalid_request' });
    });
    it('creates an agent and shows the key exactly once', async () => {
      const session = await login(h);
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/admin/agents',
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        payload: { name: 'gamma' },
      });
      expect(created.statusCode).toBe(201);
      const body = IssuedKeySchema.parse(created.json());
      expect(body.key.startsWith(`dgp_${body.agent.id}_`)).toBe(true);

      const listed = await h.app.inject({
        method: 'GET',
        url: '/api/admin/agents',
        headers: { cookie: session.cookie },
      });
      expect(JSON.stringify(listed.json())).not.toContain(body.key);
      const rows = z.array(AdminAgentSchema).parse(listed.json());
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
      const body = SpaceMembersSchema.parse(members.json());
      expect(body.current.map((m) => m.agent.id)).toEqual([alpha.id]);
      expect(body.history.map((m) => m.agent.id)).toEqual([beta.id]);
      expect(body.history[0]?.revokedAt).toEqual(expect.any(String));
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
      const page = MessagePageSchema.parse(first.json());
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
      expect(ConversationSchema.parse(renamed.json())).toMatchObject({
        id: conversation,
        title: 'the weekly figures',
      });

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
      const threads = z.array(ConversationSummarySchema).parse(response.json());

      const busy = threads.find((t) => t.id === conversation);
      expect(busy?.messageCount).toBe(1);
      expect(busy?.openedBy).toMatchObject({ kind: 'human' });
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
      expect(PostResultSchema.parse(first.json()).conversation.title).toBe('from the human');
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
      const {
        escalations: rows,
        unacknowledged,
        undelivered,
        webhookConfigured,
      } = EscalationsResponseSchema.parse(inbox.json());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent.id).toBe(alpha.id);
      expect(rows[0]?.conversation.id).toBe(conversation);
      expect(rows[0]?.notification.state).toBe('pending');
      expect(rows[0]?.acknowledgedAt).toBe(null);
      // The headline count is what still wants a human; delivery is detail
      // beside it, and this harness runs with no webhook, so the UI can drop
      // delivery state entirely.
      expect(unacknowledged).toBe(1);
      expect(undelivered).toBe(1);
      expect(webhookConfigured).toBe(false);

      const found = await h.app.inject({
        method: 'GET',
        url: '/api/admin/search?q=figures',
        headers: { cookie: session.cookie },
      });
      const { results: hits, hasMore } = SearchResponseSchema.parse(found.json());
      expect(hits).toHaveLength(1);
      expect(hits[0]?.space.id).toBe(space);
      expect(hasMore).toBe(false);
    });

    it('pages the inbox newest first with a cursor, and counts the undelivered whole', async () => {
      for (const n of [1, 2, 3]) {
        await asAgent(alpha.key, {
          method: 'POST',
          url: '/api/agent/escalations',
          payload: { conversation, reason: `problem ${n}`, idempotencyKey: `p${n}` },
        });
        // Distinct created_at: within one millisecond the id breaks the tie,
        // which is stable but not chronological.
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const session = await login(h);
      const page = async (query: string): Promise<EscalationsBody> =>
        (
          await h.app.inject({
            method: 'GET',
            url: `/api/admin/escalations?${query}`,
            headers: { cookie: session.cookie },
          })
        ).json() as EscalationsBody;

      const first = await page('limit=2');
      expect(first.escalations.map((e) => e.reason)).toEqual(['problem 3', 'problem 2']);
      expect(first.hasMore).toBe(true);
      expect(first.undelivered).toBe(3);
      const rest = await page(`limit=2&after=${encodeURIComponent(first.nextCursor ?? '')}`);
      expect(rest.escalations.map((e) => e.reason)).toEqual(['problem 1']);
      expect(rest.hasMore).toBe(false);
      const oldest = await page('order=oldest&limit=1');
      expect(oldest.escalations.map((e) => e.reason)).toEqual(['problem 1']);

      const bad = await h.app.inject({
        method: 'GET',
        url: '/api/admin/escalations?after=nope',
        headers: { cookie: session.cookie },
      });
      expect(bad.statusCode).toBe(400);
    });

    it('acknowledges an escalation, moves the headline count, and 404s an unknown id', async () => {
      await asAgent(alpha.key, {
        method: 'POST',
        url: '/api/agent/escalations',
        payload: { conversation, reason: 'numbers look wrong', idempotencyKey: 'ack1' },
      });
      const session = await login(h);
      const inbox = async (): Promise<EscalationsBody> =>
        (
          await h.app.inject({
            method: 'GET',
            url: '/api/admin/escalations',
            headers: { cookie: session.cookie },
          })
        ).json() as EscalationsBody;

      const before = await inbox();
      expect(before.unacknowledged).toBe(1);
      const id = before.escalations[0]?.id ?? '';

      const acked = await h.app.inject({
        method: 'POST',
        url: `/api/admin/escalations/${id}/ack`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      expect(acked.statusCode).toBe(200);
      expect(EscalationSchema.parse(acked.json()).acknowledgedAt).not.toBe(null);

      const after = await inbox();
      expect(after.unacknowledged).toBe(0);
      expect(after.escalations[0]?.acknowledgedAt).not.toBe(null);

      // Idempotent: a second ack still succeeds and the count stays put.
      const again = await h.app.inject({
        method: 'POST',
        url: `/api/admin/escalations/${id}/ack`,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      expect(again.statusCode).toBe(200);
      expect((await inbox()).unacknowledged).toBe(0);

      const missing = await h.app.inject({
        method: 'POST',
        url: '/api/admin/escalations/esc_nope/ack',
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      });
      expect(missing.statusCode).toBe(404);
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

describe('the agent guide', () => {
  let h: Harness;
  afterEach(() => teardown(h));

  it('is served as plain text, without authentication, when the file exists', async () => {
    h = await harness();
    const guide = join(h.dir, 'agent-guide.md');
    writeFileSync(guide, '# Dogpark: a guide for agents\n');
    const app = await buildApp({ store: h.store, config: h.config, guidePath: guide });
    try {
      const response = await app.inject({ method: 'GET', url: '/agent-guide.md' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(response.body).toBe('# Dogpark: a guide for agents\n');
    } finally {
      await app.close();
    }
  });

  it('is not_found in the API shape when no file was found', async () => {
    h = await harness();
    const response = await h.app.inject({ method: 'GET', url: '/agent-guide.md' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'not_found', message: 'not found' });
  });
});

describe('the bash client', () => {
  let h: Harness;
  afterEach(() => teardown(h));

  it('is served as plain text, without authentication, when the file exists', async () => {
    h = await harness();
    const client = join(h.dir, 'dogpark');
    writeFileSync(client, '#!/usr/bin/env bash\nset -euo pipefail\n');
    const app = await buildApp({ store: h.store, config: h.config, clientPath: client });
    try {
      const response = await app.inject({ method: 'GET', url: '/dogpark.sh' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(response.body.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('is not_found in the API shape when no file was found', async () => {
    h = await harness();
    const response = await h.app.inject({ method: 'GET', url: '/dogpark.sh' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'not_found', message: 'not found' });
  });
});

describe("the human's long poll and space counts", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => teardown(h));

  const versionOf = (response: LightMyRequestResponse): string =>
    ChangesResponseSchema.parse(response.json()).version;

  const human = async (): Promise<{
    cookie: string;
    csrf: string;
    get: (url: string) => Promise<LightMyRequestResponse>;
    post: (url: string, payload: Record<string, unknown>) => Promise<LightMyRequestResponse>;
    send: (
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: string,
      payload?: Record<string, unknown>,
    ) => Promise<LightMyRequestResponse>;
  }> => {
    const session = await login(h);
    const send = (
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: string,
      payload?: Record<string, unknown>,
    ): Promise<LightMyRequestResponse> =>
      h.app.inject({
        method,
        url,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
        ...(payload === undefined ? {} : { payload }),
      });
    return {
      ...session,
      get: (url) => h.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } }),
      post: (url, payload) => send('POST', url, payload),
      send,
    };
  };

  it('reports the version at once without `after`, or when `after` is not the current one', async () => {
    const me = await human();
    expect(versionOf(await me.get('/api/admin/changes'))).toMatch(/^[0-9a-f]{8}:0$/);
    // A version from before a restart carries another epoch: answered at
    // once rather than waited on, however its count compares.
    const stale = await me.get('/api/admin/changes?after=deadbeef:0&waitSeconds=2');
    expect(versionOf(stale)).toMatch(/:0$/);
    expect(versionOf(stale)).not.toBe('deadbeef:0');
  });

  it('holds until a write, then reports the version it moved to', async () => {
    const me = await human();
    const space = (await me.post('/api/admin/spaces', { name: 'acme' })).json() as { id: string };
    // Creating the space is itself a change the UI shows, so the version has
    // already moved once.
    const before = versionOf(await me.get('/api/admin/changes'));
    expect(before).toMatch(/:1$/);

    const waiting = me.get(`/api/admin/changes?after=${before}&waitSeconds=2`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await me.post('/api/admin/messages', {
      target: { space: space.id, title: 'hello' },
      body: 'anyone here?',
    });
    const woke = await waiting;
    expect(versionOf(woke)).toBe(before.replace(/:1$/, ':2'));
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('moves on every mutation the UI shows, not only the ones agents wake for', async () => {
    const me = await human();
    let last = versionOf(await me.get('/api/admin/changes'));
    const moved = async (): Promise<void> => {
      const now = versionOf(await me.get('/api/admin/changes'));
      expect(now).not.toBe(last);
      last = now;
    };
    const held = async (): Promise<void> => {
      expect(versionOf(await me.get('/api/admin/changes'))).toBe(last);
    };

    const space = (await me.post('/api/admin/spaces', { name: 'acme' })).json() as { id: string };
    await moved();
    await me.send('PATCH', `/api/admin/spaces/${space.id}`, { name: 'acme-renamed' });
    await moved();

    const created = (await me.post('/api/admin/agents', { name: 'watcher' })).json() as {
      agent: { id: string };
      keyId: string;
      key: string;
    };
    await moved();
    await me.send('PATCH', `/api/admin/agents/${created.agent.id}`, { name: 'lookout' });
    await moved();

    const issued = (await me.post(`/api/admin/agents/${created.agent.id}/keys`, {})).json() as {
      keyId: string;
    };
    await moved();
    await me.send('DELETE', `/api/admin/agents/${created.agent.id}/keys/${issued.keyId}`);
    await moved();

    await me.send('PUT', `/api/admin/spaces/${space.id}/members/${created.agent.id}`);
    await moved();

    const posted = (
      await me.post('/api/admin/messages', {
        target: { space: space.id, title: 'watch this' },
        body: 'a thread to rename',
      })
    ).json() as { conversation: { id: string } };
    await moved();
    await me.send('PATCH', `/api/admin/conversations/${posted.conversation.id}`, {
      title: 'watched',
    });
    await moved();

    const escalate = (): Promise<LightMyRequestResponse> =>
      h.app.inject({
        method: 'POST',
        url: '/api/agent/escalations',
        headers: { authorization: `Bearer ${created.key}` },
        payload: {
          conversation: posted.conversation.id,
          reason: 'checking the wiring',
          idempotencyKey: 'esc-1',
        },
      });
    expect((await escalate()).statusCode).toBe(204);
    await moved();
    // A replayed escalation recorded nothing, so it is not a change.
    expect((await escalate()).statusCode).toBe(204);
    await held();

    // Acknowledging is a write the UI shows: the badge and the row both move.
    const inbox = (await me.get('/api/admin/escalations')).json() as {
      escalations: { id: string }[];
    };
    await me.send('POST', `/api/admin/escalations/${inbox.escalations[0]?.id}/ack`);
    await moved();

    await me.send('POST', `/api/admin/agents/${created.agent.id}/archive`);
    await moved();
    await me.send('POST', `/api/admin/agents/${created.agent.id}/unarchive`);
    await moved();
  });

  it('does not wake an agent stream poll for a write only the UI shows', async () => {
    // The reason the signal is split: waking an agent's poll hands it an
    // empty page and spends a read-log row on a read nobody wanted. A rename
    // changes what the UI shows, but puts nothing on any agent's stream.
    const me = await human();
    const record = h.store.createAgent('bystander');
    const key = h.store.issueKey(record.id).key;
    const space = h.store.createSpace('quiet');
    h.store.grantMembership(record.id, space.id);

    const tip = await h.app.inject({
      method: 'GET',
      url: '/api/agent/stream?tip=true',
      headers: { authorization: `Bearer ${key}` },
    });
    const cursor = (tip.json() as { nextCursor: string }).nextCursor;

    const started = Date.now();
    const waiting = h.app.inject({
      method: 'GET',
      url: `/api/agent/stream?after=${encodeURIComponent(cursor)}&waitSeconds=2`,
      headers: { authorization: `Bearer ${key}` },
    });
    const renamed = new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
      me.send('PATCH', `/api/admin/spaces/${space.id}`, { name: 'renamed-under-them' }),
    );

    // The rename really happened, and landed while the poll was still
    // waiting — a poll that outlasts a failed or late write proves nothing.
    expect((await renamed).statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1500);

    const response = await waiting;
    const elapsed = Date.now() - started;
    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: unknown[] }).items).toEqual([]);
    // Timed out rather than woken: the rename reached the UI signal only.
    expect(elapsed).toBeGreaterThanOrEqual(1500);
  });

  it('times out to the unchanged version when nothing is written', async () => {
    const me = await human();
    const before = versionOf(await me.get('/api/admin/changes'));
    const started = Date.now();
    const quiet = await me.get(`/api/admin/changes?after=${before}&waitSeconds=1`);
    expect(versionOf(quiet)).toBe(before);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('lists every space with its thread and message counts', async () => {
    const me = await human();
    const acme = (await me.post('/api/admin/spaces', { name: 'acme' })).json() as { id: string };
    await me.post('/api/admin/spaces', { name: 'quiet' });
    await me.post('/api/admin/messages', { target: { space: acme.id, title: 'one' }, body: 'a' });
    await me.post('/api/admin/messages', { target: { space: acme.id, title: 'one' }, body: 'b' });
    await me.post('/api/admin/messages', { target: { space: acme.id, title: 'two' }, body: 'c' });

    const listed = z.array(SpaceSummarySchema).parse((await me.get('/api/admin/spaces')).json());
    expect(listed.map((s) => s.name)).toEqual(['acme', 'quiet']);
    expect(listed[0]).toMatchObject({ conversationCount: 2, messageCount: 3 });
    expect(listed[0]?.lastActivityAt).toEqual(expect.any(String));
    expect(listed[1]).toMatchObject({
      conversationCount: 0,
      messageCount: 0,
      lastActivityAt: null,
    });
  });

  it('lists catch-up rows and advances a human read mark', async () => {
    const me = await human();
    const space = (await me.post('/api/admin/spaces', { name: 'catch-up' })).json() as {
      id: string;
    };
    const posted = (
      await me.post('/api/admin/messages', {
        target: { space: space.id, title: 'news' },
        body: 'hello',
      })
    ).json() as { conversation: { id: string }; message: { id: string } };

    const page = HumanCatchUpPageSchema.parse((await me.get('/api/admin/catch-up')).json());
    expect(page.conversations[0]).toMatchObject({ title: 'news', unreadCount: 1 });
    expect(
      (
        await me.send('POST', '/api/admin/read-mark', {
          conversation: posted.conversation.id,
          message: posted.message.id,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      HumanCatchUpPageSchema.parse((await me.get('/api/admin/catch-up')).json()).conversations,
    ).toEqual([]);
    const spaces = z.array(SpaceSummarySchema).parse((await me.get('/api/admin/spaces')).json());
    expect(spaces[0]?.unreadCount).toBe(0);
  });
});
