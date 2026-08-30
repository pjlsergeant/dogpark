import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentId,
  AttachmentId,
  ConversationId,
  Cursor,
  IdempotencyKey,
  Message,
  QueryCursor,
  SpaceId,
  StreamItem,
  Timestamp,
} from '../types.js';
import { StoreError } from './errors.js';
import { newAttachmentId, openStore, type Store, type ReadLogCursor } from './index.js';
import { RESERVED_SEQUENCE } from './text.js';

// ---------------------------------------------------------------------------
// Harness: a real on-disk database per test, and a clock the test can move so
// that timestamp ranges are testable without sleeping.
// ---------------------------------------------------------------------------

interface Harness {
  readonly store: Store;
  advance(seconds: number): void;
  at(): Timestamp;
}

const open: Store[] = [];
const dirs: string[] = [];

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dogpark-store-'));
  dirs.push(dir);
  let millis = Date.parse('2026-01-01T00:00:00.000Z');
  const store = openStore({
    file: join(dir, 'nested', 'dogpark.db'),
    humanDisplayName: 'the human',
    now: () => new Date(millis),
  });
  open.push(store);
  return {
    store,
    advance(seconds) {
      millis += seconds * 1000;
    },
    at() {
      return new Date(millis).toISOString() as Timestamp;
    },
  };
}

afterEach(() => {
  for (const store of open.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectStoreError(fn: () => unknown, code: string): StoreError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    const store = error as StoreError;
    expect(store.code).toBe(code);
    return store;
  }
  throw new Error('expected a StoreError, but nothing was thrown');
}

function bodies(items: readonly StreamItem[]): string[] {
  return items.filter((i): i is Message => i.kind === 'message').map((i) => i.body);
}

function kinds(items: readonly StreamItem[]): string[] {
  return items.map((i) => i.kind);
}

const key = (value: string): IdempotencyKey => value as IdempotencyKey;

/** A space with one member, which most tests need before anything else. */
function scene(h: Harness): { agent: AgentId; space: SpaceId } {
  const agent = h.store.createAgent('alice').id;
  const space = h.store.createSpace('acme').id;
  h.store.grantMembership(agent, space);
  return { agent, space };
}

function post(h: Harness, agent: AgentId, space: SpaceId, title: string, body: string): Message {
  return h.store.postMessage({
    sender: { kind: 'agent', id: agent },
    target: { space, title },
    body,
  }).message;
}

// ---------------------------------------------------------------------------

describe('membership is append-only intervals', () => {
  it('opens a new interval on re-grant and never clears a revocation', () => {
    const h = harness();
    const { agent, space } = scene(h);

    h.advance(60);
    h.store.revokeMembership(agent, space);
    h.advance(60);
    h.store.grantMembership(agent, space);

    const intervals = h.store.listMembershipIntervals({ agent, space });
    expect(intervals).toHaveLength(2);
    expect(intervals[0]?.revokedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(intervals[1]?.revokedAt).toBeNull();
  });

  it('treats adding an already-current member as a no-op, not a second interval', () => {
    const h = harness();
    const { agent, space } = scene(h);

    expect(h.store.grantMembership(agent, space)).toBe(false);

    expect(h.store.listMembershipIntervals({ agent, space })).toHaveLength(1);
    // And no second announcement: nothing happened, so nothing is announced.
    expect(kinds(h.store.readStream(agent).items)).toEqual(['space_access_granted']);
  });

  it('refuses a second open interval at the schema level', () => {
    const h = harness();
    const { agent, space } = scene(h);

    expect(() =>
      h.store.database
        .prepare(
          'INSERT INTO membership (id, agent_id, space_id, granted_at, granted_seq) ' +
            "VALUES ('x', ?, ?, '2026-01-01T00:00:00.000Z', 99)",
        )
        .run(agent, space),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('reports revoking a non-member as a no-op', () => {
    const h = harness();
    const agent = h.store.createAgent('alice').id;
    const space = h.store.createSpace('acme').id;
    expect(h.store.revokeMembership(agent, space)).toBe(false);
  });

  it('keeps membership across archive and unarchive', () => {
    const h = harness();
    const { agent, space } = scene(h);
    h.store.archiveAgent(agent);
    expect(h.store.listSpacesForAgent(agent).map((s) => s.id)).toEqual([space]);
    h.store.unarchiveAgent(agent);
    expect(h.store.listSpacesForAgent(agent).map((s) => s.id)).toEqual([space]);
  });
});

describe('messages are immutable', () => {
  // ADR-0004. Asserted against what a reader gets back, because a test of the
  // method names would pass just as happily beside a `reviseMessage`.
  it('reads back what was posted, however the thread is read', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const reader = { kind: 'agent', id: agent } as const;

    const posted = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'the original wording',
      idempotencyKey: key('immutable-1'),
    });
    h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { conversation: posted.conversation.id },
      body: 'a correction, as a new message',
      idempotencyKey: key('immutable-2'),
    });

    const bodies = h.store
      .readConversation(reader, posted.conversation.id)
      .messages.map((m) => m.body);
    expect(bodies).toEqual(['the original wording', 'a correction, as a new message']);
    expect(h.store.readSpace(reader, space).messages[0]?.body).toBe('the original wording');
    // The stream carries system events alongside messages; the bodies are what
    // this is about.
    const streamed = h.store
      .readStream(agent, {})
      .items.filter((item): item is Message => 'body' in item)
      .map((m) => m.body);
    expect(streamed).toEqual(['the original wording', 'a correction, as a new message']);
  });
});

describe('ordering', () => {
  it('allocates one sequence across messages and system events', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const other = h.store.createSpace('beta').id;

    post(h, agent, space, 'notes', 'one');
    h.store.grantMembership(agent, other);
    post(h, agent, other, 'notes', 'two');

    // One space, so no message shares a sequence with an event (ADR-0009).
    // Distinctness is the guarantee; the particular numbers are not.
    const seqs = (
      h.store.database
        .prepare('SELECT seq FROM message UNION ALL SELECT seq FROM system_event ORDER BY seq')
        .all() as { seq: number }[]
    ).map((r) => r.seq);
    expect(seqs).toHaveLength(4);
    expect(new Set(seqs).size).toBe(4);
  });

  it('returns items in sequence order, interleaving events and messages', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const other = h.store.createSpace('beta').id;

    post(h, agent, space, 'notes', 'one');
    h.store.grantMembership(agent, other);
    post(h, agent, other, 'notes', 'two');

    expect(kinds(h.store.readStream(agent).items)).toEqual([
      'space_access_granted',
      'message',
      'space_access_granted',
      'message',
    ]);
  });

  it('hands out cursors that are opaque and not interchangeable with query cursors', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');

    const stream = h.store.readStream(agent).nextCursor;
    const query = h.store.readSpace({ kind: 'agent', id: agent }, space).nextCursor;
    expect(stream).not.toMatch(/^\d+$/);
    expect(stream).not.toBe(query);

    expectStoreError(
      () => h.store.readStream(agent, { from: { after: query as unknown as Cursor } }),
      'invalid_request',
    );
    expectStoreError(
      () =>
        h.store.readSpace({ kind: 'agent', id: agent }, space, {
          after: stream as unknown as QueryCursor,
        }),
      'invalid_request',
    );
  });
});

describe('readStream access filter', () => {
  it('does not replay history from before the grant', () => {
    const h = harness();
    const writer = h.store.createAgent('writer').id;
    const space = h.store.createSpace('acme').id;
    h.store.grantMembership(writer, space);
    post(h, writer, space, 'notes', 'before');

    const late = h.store.createAgent('late').id;
    h.store.grantMembership(late, space);
    post(h, writer, space, 'notes', 'after');

    const page = h.store.readStream(late);
    expect(kinds(page.items)).toEqual(['space_access_granted', 'message']);
    expect(bodies(page.items)).toEqual(['after']);

    // Access is not delivery: the history is readable, just not replayed.
    const backfill = h.store.readConversation(
      { kind: 'agent', id: late },
      page.items.find((i): i is Message => i.kind === 'message')?.conversation ??
        ('' as ConversationId),
    );
    expect(backfill.messages.map((m) => m.body)).toEqual(['before', 'after']);
  });

  it('skips an unreachable backlog and advances the cursor past it', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'seen-never');
    h.store.revokeMembership(agent, space);

    const page = h.store.readStream(agent);
    // The message fails the current-access test and is skipped; the revocation
    // event is exempt from that test and delivers.
    expect(kinds(page.items)).toEqual(['space_access_granted', 'space_access_revoked']);
    expect(page.hasMore).toBe(false);

    // The cursor moved past the skipped message, so a second read stalls at
    // nothing rather than re-offering it.
    const again = h.store.readStream(agent, { from: { after: page.nextCursor } });
    expect(again.items).toEqual([]);
    expect(again.nextCursor).toBe(page.nextCursor);
  });

  it('leaves the cursor at the live edge when the tail was all filtered out', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const peer = h.store.createAgent('bob').id;
    h.store.grantMembership(peer, space);

    h.store.revokeMembership(agent, space);
    // Written after the revocation, so it is behind the cursor and invisible.
    post(h, peer, space, 'notes', 'unreachable');

    const page = h.store.readStream(agent);
    expect(bodies(page.items)).toEqual([]);
    // The cursor moved past the filtered tail rather than stopping at the last
    // item it could deliver: the tip is where a fresh reader would start.
    expect(page.nextCursor).toBe(h.store.readStream(peer, { from: { from: 'tip' } }).nextCursor);
    expect(h.store.readReadLog({ agent }).entries[0]?.cursor).toBe(page.nextCursor);
  });

  it('never re-delivers what it skipped, even after access returns', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'skipped');
    h.store.revokeMembership(agent, space);

    const first = h.store.readStream(agent);
    h.store.grantMembership(agent, space);
    post(h, agent, space, 'notes', 'fresh');

    const second = h.store.readStream(agent, { from: { after: first.nextCursor } });
    expect(kinds(second.items)).toEqual(['space_access_granted', 'message']);
    expect(bodies(second.items)).toEqual(['fresh']);

    // ...but the skipped message is still readable by query.
    const backfill = h.store.readSpace({ kind: 'agent', id: agent }, space);
    expect(backfill.messages.map((m) => m.body)).toEqual(['skipped', 'fresh']);
  });

  it('is deliberately not reproducible from the same cursor', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const start = h.store.readStream(agent, { from: { from: 'tip' } }).nextCursor;
    post(h, agent, space, 'notes', 'one');

    expect(bodies(h.store.readStream(agent, { from: { after: start } }).items)).toEqual(['one']);
    h.store.revokeMembership(agent, space);
    expect(bodies(h.store.readStream(agent, { from: { after: start } }).items)).toEqual([]);
  });

  it('delivers only the reading agent its own events', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const bystander = h.store.createAgent('bystander').id;
    h.store.grantMembership(bystander, space);

    expect(h.store.readStream(agent).items).toHaveLength(1);
  });

  it('paginates without stalling and always returns a cursor', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');
    post(h, agent, space, 'notes', 'two');

    const first = h.store.readStream(agent, { limit: 1 });
    expect(first.hasMore).toBe(true);
    expect(kinds(first.items)).toEqual(['space_access_granted']);

    const second = h.store.readStream(agent, { from: { after: first.nextCursor }, limit: 1 });
    expect(bodies(second.items)).toEqual(['one']);
    expect(second.hasMore).toBe(true);

    const third = h.store.readStream(agent, { from: { after: second.nextCursor }, limit: 1 });
    expect(bodies(third.items)).toEqual(['two']);
    expect(third.hasMore).toBe(false);

    const empty = h.store.readStream(agent, { from: { after: third.nextCursor } });
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBe(third.nextCursor);
  });
});

describe('ReadFrom', () => {
  it('starts at the live edge with nothing behind it', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'old');

    const page = h.store.readStream(agent, { from: { from: 'tip' } });
    expect(page.items).toEqual([]);

    post(h, agent, space, 'notes', 'new');
    expect(bodies(h.store.readStream(agent, { from: { after: page.nextCursor } }).items)).toEqual([
      'new',
    ]);
  });

  it('anchors inclusively on a timestamp', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'before');
    h.advance(60);
    const boundary = h.at();
    post(h, agent, space, 'notes', 'at-boundary');
    h.advance(60);
    post(h, agent, space, 'notes', 'after');

    expect(bodies(h.store.readStream(agent, { from: { since: boundary } }).items)).toEqual([
      'at-boundary',
      'after',
    ]);
  });

  it('accepts a timestamp written without milliseconds', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'at-boundary');

    const coarse = '2026-01-01T00:00:00Z' as Timestamp;
    expect(bodies(h.store.readStream(agent, { from: { since: coarse } }).items)).toEqual([
      'at-boundary',
    ]);
  });
});

describe('queries are not stream positions', () => {
  it('honours current access and reads history the stream never delivered', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');

    h.store.revokeMembership(agent, space);
    expectStoreError(() => h.store.readSpace({ kind: 'agent', id: agent }, space), 'not_found');

    h.store.grantMembership(agent, space);
    expect(
      h.store.readSpace({ kind: 'agent', id: agent }, space).messages.map((m) => m.body),
    ).toEqual(['one']);
  });

  it('does not advance the stream cursor', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');

    h.store.readSpace({ kind: 'agent', id: agent }, space);
    h.store.readConversation(
      { kind: 'agent', id: agent },
      h.store.listConversationSummaries(space)[0]?.id ?? ('' as ConversationId),
    );

    // Neither query recorded a stream position, so the stream still owes the
    // agent everything.
    expect(h.store.lastReadCursor(agent)).toBeUndefined();
    expect(bodies(h.store.readStream(agent).items)).toEqual(['one']);
  });

  it('treats since as inclusive and until as exclusive', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'first');
    h.advance(60);
    const middle = h.at();
    post(h, agent, space, 'notes', 'second');
    h.advance(60);
    const end = h.at();
    post(h, agent, space, 'notes', 'third');

    const page = h.store.readSpace({ kind: 'agent', id: agent }, space, {
      since: middle,
      until: end,
    });
    expect(page.messages.map((m) => m.body)).toEqual(['second']);
  });

  it('pages within a range with a query cursor and leaves an empty page in place', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');
    post(h, agent, space, 'notes', 'two');

    const first = h.store.readSpace({ kind: 'agent', id: agent }, space, undefined, 1);
    expect(first.messages.map((m) => m.body)).toEqual(['one']);
    expect(first.hasMore).toBe(true);

    const second = h.store.readSpace(
      { kind: 'agent', id: agent },
      space,
      { after: first.nextCursor },
      1,
    );
    expect(second.messages.map((m) => m.body)).toEqual(['two']);
    expect(second.hasMore).toBe(false);

    const third = h.store.readSpace({ kind: 'agent', id: agent }, space, {
      after: second.nextCursor,
    });
    expect(third.messages).toEqual([]);
    // A query skips nothing, so an empty page leaves the position untouched —
    // the opposite of the stream, which jumps past what it filtered out.
    expect(third.nextCursor).toBe(second.nextCursor);
  });

  it('reports not found for a space the agent cannot see', () => {
    const h = harness();
    const { agent } = scene(h);
    const secret = h.store.createSpace('secret').id;
    expectStoreError(() => h.store.readSpace({ kind: 'agent', id: agent }, secret), 'not_found');
    // Indistinguishable from a space that does not exist at all.
    expectStoreError(
      () => h.store.readSpace({ kind: 'agent', id: agent }, 'nosuchspace00000' as SpaceId),
      'not_found',
    );
  });
});

describe('idempotency', () => {
  it('replays the original result rather than writing twice', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const request = {
      sender: { kind: 'agent', id: agent } as const,
      target: { space, title: 'notes' },
      body: 'hello',
      idempotencyKey: key('k1'),
    };

    const first = h.store.postMessage(request);
    const second = h.store.postMessage(request);

    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(h.store.readSpace({ kind: 'agent', id: agent }, space).messages).toHaveLength(1);
  });

  it('rejects a different request under the same key', () => {
    const h = harness();
    const { agent, space } = scene(h);
    h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'hello',
      idempotencyKey: key('k1'),
    });

    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'agent', id: agent },
          target: { space, title: 'notes' },
          body: 'something else',
          idempotencyKey: key('k1'),
        }),
      'invalid_request',
    );
    expect(h.store.readSpace({ kind: 'agent', id: agent }, space).messages).toHaveLength(1);
  });

  it('is scoped per agent', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const other = h.store.createAgent('bob').id;
    h.store.grantMembership(other, space);

    h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'from alice',
      idempotencyKey: key('shared'),
    });
    const second = h.store.postMessage({
      sender: { kind: 'agent', id: other },
      target: { space, title: 'notes' },
      body: 'from bob',
      idempotencyKey: key('shared'),
    });

    expect(second.created).toBe(true);
    expect(h.store.readSpace({ kind: 'agent', id: agent }, space).messages).toHaveLength(2);
  });

  it('scopes the human separately from every agent, and durably', () => {
    const h = harness();
    const { agent, space } = scene(h);

    const first = h.store.postMessage({
      sender: { kind: 'human' },
      target: { space, title: 'notes' },
      body: 'from the human',
      idempotencyKey: key('shared'),
    });
    // The same key from an agent is a different writer, so it writes.
    const byAgent = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'from alice',
      idempotencyKey: key('shared'),
    });
    // The human replaying its own key does not.
    const replay = h.store.postMessage({
      sender: { kind: 'human' },
      target: { space, title: 'notes' },
      body: 'from the human',
      idempotencyKey: key('shared'),
    });

    expect(byAgent.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.message.id).toBe(first.message.id);
    expect(h.store.readSpace({ kind: 'agent', id: agent }, space).messages).toHaveLength(2);
  });

  it("keeps the human's namespace clear of an agent literally named as one", () => {
    const h = harness();
    const space = h.store.createSpace('acme').id;
    // The schema does not constrain agent.id, so a hand-written row can hold
    // anything. The human's writer carries a character the id alphabet does
    // not, so no such row can reach into the human's keys (schema.sql).
    h.store.database
      .prepare(
        "INSERT INTO agent (id, display_name, created_at, archived) VALUES ('human', 'impostor', 'then', 0)",
      )
      .run();
    const impostor = 'human' as AgentId;
    h.store.grantMembership(impostor, space);

    const byImpostor = h.store.postMessage({
      sender: { kind: 'agent', id: impostor },
      target: { space, title: 'notes' },
      body: 'from the impostor',
      idempotencyKey: key('collide'),
    });
    const byHuman = h.store.postMessage({
      sender: { kind: 'human' },
      target: { space, title: 'notes' },
      body: 'from the actual human',
      idempotencyKey: key('collide'),
    });

    // Two writes, not a replay of the first.
    expect(byHuman.created).toBe(true);
    expect(byHuman.message.id).not.toBe(byImpostor.message.id);
  });

  it('refuses to write a key for an agent hand-named as the sentinel', () => {
    const h = harness();
    const space = h.store.createSpace('acme').id;
    h.store.database
      .prepare(
        "INSERT INTO agent (id, display_name, created_at, archived) VALUES (':human', 'impostor', 'then', 0)",
      )
      .run();
    const impostor = ':human' as AgentId;
    h.store.grantMembership(impostor, space);

    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'agent', id: impostor },
          target: { space, title: 'notes' },
          body: 'reaching for the human keys',
          idempotencyKey: key('reserved'),
        }),
      'invalid_request',
    );
  });

  it('rejects a replayed human key that carries a different request', () => {
    const h = harness();
    const { space } = scene(h);
    h.store.postMessage({
      sender: { kind: 'human' },
      target: { space, title: 'notes' },
      body: 'the first thing',
      idempotencyKey: key('reused'),
    });
    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'human' },
          target: { space, title: 'notes' },
          body: 'something else entirely',
          idempotencyKey: key('reused'),
        }),
      'invalid_request',
    );
  });

  it('writes the key only with the write it covers', () => {
    const h = harness();
    const { agent, space } = scene(h);

    // Fails after the key would have been claimed, had it been claimed early.
    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'agent', id: agent },
          target: { conversation: 'nosuchconvo0000' as ConversationId },
          body: 'hello',
          idempotencyKey: key('k1'),
        }),
      'not_found',
    );

    const rows = h.store.database.prepare('SELECT COUNT(*) AS n FROM idempotency').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);

    // So the same key is still usable for the retry that succeeds.
    const retry = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'hello',
      idempotencyKey: key('k1'),
    });
    expect(retry.created).toBe(true);
  });

  it('replays an escalation rather than waking someone twice', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const conversation = h.store.resolveOrCreateConversation(space, 'notes').id;
    const request = {
      agent,
      conversation,
      reason: 'the numbers do not add up',
      idempotencyKey: key('e1'),
    };

    const first = h.store.recordEscalation(request);
    const second = h.store.recordEscalation(request);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.escalation.id).toBe(first.escalation.id);
    expect(h.store.listEscalations()).toHaveLength(1);

    expectStoreError(
      () => h.store.recordEscalation({ ...request, reason: 'different reason' }),
      'invalid_request',
    );
  });
});

describe('one idempotency namespace serves posts and escalations', () => {
  it('rejects a post key replayed as an escalation, as a different request', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const posted = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'hello',
      idempotencyKey: key('shared'),
    });
    expectStoreError(
      () =>
        h.store.recordEscalation({
          agent,
          conversation: posted.conversation.id,
          reason: 'help',
          idempotencyKey: key('shared'),
        }),
      'invalid_request',
    );
  });

  it('rejects an escalation key replayed as a post, as a different request', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const conversation = h.store.resolveOrCreateConversation(space, 'notes').id;
    h.store.recordEscalation({
      agent,
      conversation,
      reason: 'help',
      idempotencyKey: key('shared'),
    });
    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'agent', id: agent },
          target: { conversation },
          body: 'hello',
          idempotencyKey: key('shared'),
        }),
      'invalid_request',
    );
  });
});

describe('titles are unique within a space', () => {
  it('resolves an existing conversation or opens one, atomically', () => {
    const h = harness();
    const { agent, space } = scene(h);

    const first = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'daily' },
      body: 'one',
    });
    const second = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'daily' },
      body: 'two',
    });

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(h.store.listConversationSummaries(space)).toHaveLength(1);
  });

  it('scopes titles to the space', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const other = h.store.createSpace('beta').id;
    h.store.grantMembership(agent, other);

    const a = h.store.resolveOrCreateConversation(space, 'daily');
    const b = h.store.resolveOrCreateConversation(other, 'daily');
    expect(a.id).not.toBe(b.id);
  });

  it('refuses a rename onto a title already used in the space', () => {
    const h = harness();
    const { space } = scene(h);
    h.store.resolveOrCreateConversation(space, 'one');
    const second = h.store.resolveOrCreateConversation(space, 'two');
    expectStoreError(() => h.store.renameConversation(second.id, 'one'), 'invalid_request');
  });

  it('carries the conversation title on every message, and renames it in place', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const posted = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'daily' },
      body: 'one',
    });
    expect(posted.message.conversationTitle).toBe('daily');

    h.store.renameConversation(posted.conversation.id, 'weekly');
    const reread = h.store.readSpace({ kind: 'agent', id: agent }, space).messages[0];
    expect(reread?.conversationTitle).toBe('weekly');
  });
});

describe('bodies are canonical', () => {
  it('stores a reference token and renders the current name', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const bob = h.store.createAgent('bob').id;
    h.store.grantMembership(bob, space);

    const posted = post(h, agent, space, 'notes', 'ping @bob please');
    const stored = h.store.database
      .prepare('SELECT body FROM message WHERE id = ?')
      .get(posted.id) as { body: string };

    expect(stored.body).toBe(`ping @${bob} please`);
    expect(posted.body).toBe('ping @bob please');
    expect(posted.mentions).toEqual([bob]);

    h.store.renameAgent(bob, 'robert');
    const reread = h.store.readSpace({ kind: 'agent', id: agent }, space).messages[0];
    expect(reread?.body).toBe('ping @robert please');
    expect(reread?.mentions).toEqual([bob]);
  });

  it('leaves an unresolvable name literal rather than erroring', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const posted = post(h, agent, space, 'notes', 'ping @nobody and @alice');
    expect(posted.body).toBe(`ping @nobody and @alice`);
    expect(posted.mentions).toEqual([agent]);
  });

  it('resolves names only within the space', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const stranger = h.store.createAgent('stranger').id;
    const elsewhere = h.store.createSpace('beta').id;
    h.store.grantMembership(stranger, elsewhere);

    const posted = post(h, agent, space, 'notes', 'ping @stranger');
    const stored = h.store.database
      .prepare('SELECT body FROM message WHERE id = ?')
      .get(posted.id) as { body: string };

    // Literal, and not an error: a mention that failed differently would
    // reveal whether a stranger exists.
    expect(stored.body).toBe('ping @stranger');
    expect(posted.mentions).toEqual([]);
  });

  it('does not render a hand-written token for an agent outside the space', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const stranger = h.store.createAgent('stranger').id;

    const posted = post(h, agent, space, 'notes', `ping @${stranger}`);
    expect(posted.body).toBe(`ping @${stranger}`);
    expect(posted.mentions).toEqual([]);
  });

  it('keeps punctuation next to a mention', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const posted = post(h, agent, space, 'notes', 'over to @alice.');
    expect(posted.body).toBe('over to @alice.');
    expect(posted.mentions).toEqual([agent]);
  });

  it('does not treat an email address as a mention', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const posted = post(h, agent, space, 'notes', 'mail alice@alice for details');
    const stored = h.store.database
      .prepare('SELECT body FROM message WHERE id = ?')
      .get(posted.id) as { body: string };
    expect(stored.body).toBe('mail alice@alice for details');
  });

  it('keeps mentions searchable as tokens, so a rename touches no index', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const bob = h.store.createAgent('bob').id;
    h.store.grantMembership(bob, space);
    post(h, agent, space, 'notes', 'ping @bob about invoices');

    expect(h.store.searchMessages(`"${bob}"`)).toHaveLength(1);
    expect(h.store.searchMessages('invoices')).toHaveLength(1);

    h.store.renameAgent(bob, 'robert');
    expect(h.store.searchMessages(`"${bob}"`)).toHaveLength(1);
    expect(h.store.searchMessages('robert')).toHaveLength(0);
  });
});

describe('the reserved control character', () => {
  const poison = `before${RESERVED_SEQUENCE}after`;

  it('is U+001E', () => {
    expect(RESERVED_SEQUENCE).toBe('\u001E');
  });

  it('is rejected in a body, and nothing is stored', () => {
    const h = harness();
    const { agent, space } = scene(h);
    expectStoreError(() => post(h, agent, space, 'notes', poison), 'reserved_sequence');
    expect(h.store.listConversationSummaries(space)).toHaveLength(0);
  });

  it('is rejected in a title, a filename, an escalation reason and a name', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const conversation = h.store.resolveOrCreateConversation(space, 'notes').id;

    expectStoreError(() => post(h, agent, space, poison, 'hello'), 'reserved_sequence');
    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'agent', id: agent },
          target: { space, title: 'notes' },
          body: 'hello',
          attachments: [
            {
              id: 'attachment0000a' as AttachmentId,
              filename: poison,
              contentType: 'text/plain',
              sizeBytes: 3,
            },
          ],
        }),
      'reserved_sequence',
    );
    expectStoreError(
      () =>
        h.store.recordEscalation({
          agent,
          conversation,
          reason: poison,
          idempotencyKey: key('e1'),
        }),
      'reserved_sequence',
    );
    expectStoreError(() => h.store.createAgent(poison), 'reserved_sequence');
    expectStoreError(() => h.store.createSpace(poison), 'reserved_sequence');
  });

  it('binds the human too', () => {
    const h = harness();
    const { space } = scene(h);
    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'human' },
          target: { space, title: 'notes' },
          body: poison,
        }),
      'reserved_sequence',
    );
  });
});

describe('the read log', () => {
  it('records one row per read call, with the parameters and the cursor', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');

    const stream = h.store.readStream(agent, { limit: 5 });
    h.store.readSpace({ kind: 'agent', id: agent }, space, { since: h.at() });

    const log = h.store.readReadLog({ agent }).entries;
    expect(log.map((e) => e.kind)).toEqual(['space', 'stream']);

    const streamRow = log.find((e) => e.kind === 'stream');
    expect(streamRow?.cursor).toBe(stream.nextCursor);
    expect(streamRow?.itemCount).toBe(2);
    expect(streamRow?.params).toEqual({ from: null, limit: 5 });

    const spaceRow = log.find((e) => e.kind === 'space');
    expect(spaceRow?.params).toMatchObject({ space, range: { since: h.at() } });
  });

  it('makes a jump visibly a jump', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');
    h.store.readStream(agent, { from: { from: 'tip' } });

    const entry = h.store.readReadLog({ agent }).entries[0];
    // A position log would have claimed this agent was handed everything
    // behind the cursor; the parameters say otherwise.
    expect(entry?.params).toEqual({ from: { from: 'tip' }, limit: 100 });
    expect(entry?.itemCount).toBe(0);
  });

  it('reports the last stream position, and only from stream reads', () => {
    const h = harness();
    const { agent, space } = scene(h);
    expect(h.store.lastReadCursor(agent)).toBeUndefined();

    const page = h.store.readStream(agent);
    expect(h.store.lastReadCursor(agent)).toBe(page.nextCursor);

    h.store.readSpace({ kind: 'agent', id: agent }, space);
    expect(h.store.lastReadCursor(agent)).toBe(page.nextCursor);
  });

  it('records nothing for the human, who has no agent row', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');
    h.store.readSpace({ kind: 'human' }, space);
    expect(h.store.readReadLog().entries).toHaveLength(0);
  });
});

describe('keys and authentication', () => {
  it('returns the plaintext once and stores only a hash', () => {
    const h = harness();
    const agent = h.store.createAgent('alice').id;
    const issued = h.store.issueKey(agent, 'laptop');

    expect(issued.key.startsWith(`dgp_${agent}_`)).toBe(true);
    const stored = h.store.database.prepare('SELECT * FROM api_key').all() as Record<
      string,
      unknown
    >[];
    expect(JSON.stringify(stored)).not.toContain(issued.key.split('_')[2]);
    expect(h.store.listKeys(agent).map((k) => k.label)).toEqual(['laptop']);
  });

  it('verifies, revokes, and refuses a revoked key', () => {
    const h = harness();
    const agent = h.store.createAgent('alice').id;
    const issued = h.store.issueKey(agent);

    expect(h.store.verifyKey(issued.key)?.agent.id).toBe(agent);
    h.store.revokeKey(issued.id);
    expect(h.store.verifyKey(issued.key)).toBeUndefined();
  });

  it('counts failed attempts claiming an id, separately from last-seen', () => {
    const h = harness();
    const agent = h.store.createAgent('alice').id;
    const issued = h.store.issueKey(agent);

    h.store.verifyKey(`dgp_${agent}_wrong`);
    h.store.verifyKey(`dgp_${agent}_alsowrong`);
    let record = h.store.getAgent(agent);
    expect(record?.failedAuthAttempts).toBe(2);
    expect(record?.lastSeenAt).toBeNull();

    h.advance(60);
    h.store.verifyKey(issued.key);
    record = h.store.getAgent(agent);
    expect(record?.failedAuthAttempts).toBe(2);
    expect(record?.lastSeenAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('shrugs off a key claiming an id that does not exist', () => {
    const h = harness();
    expect(h.store.verifyKey('dgp_nosuchagent000_secret')).toBeUndefined();
    expect(h.store.verifyKey('not-a-key')).toBeUndefined();
  });

  it('revokes every key on archive and refuses to issue one to an archived role', () => {
    const h = harness();
    const agent = h.store.createAgent('alice').id;
    const issued = h.store.issueKey(agent);

    h.store.archiveAgent(agent);
    expect(h.store.verifyKey(issued.key)).toBeUndefined();
    expect(h.store.listKeys(agent).every((k) => k.revokedAt !== null)).toBe(true);
    expectStoreError(() => h.store.issueKey(agent), 'invalid_request');

    // Unarchiving brings the role back; the key is fresh, because a hashed one
    // cannot be re-shown.
    h.store.unarchiveAgent(agent);
    const replacement = h.store.issueKey(agent);
    expect(h.store.verifyKey(replacement.key)?.agent.id).toBe(agent);
    expect(h.store.verifyKey(issued.key)).toBeUndefined();
  });

  it('hides archived roles from the active list', () => {
    const h = harness();
    const agent = h.store.createAgent('alice').id;
    h.store.archiveAgent(agent);
    expect(h.store.listAgents()).toHaveLength(0);
    expect(h.store.listAgents({ includeArchived: true })).toHaveLength(1);
  });
});

describe('listing peers', () => {
  it('lists only agents sharing a space', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const peer = h.store.createAgent('bob').id;
    h.store.grantMembership(peer, space);
    h.store.createAgent('stranger');

    expect(h.store.listAgentsSharingSpaceWith(agent).map((a) => a.displayName)).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('reports not found for a space the caller is not in', () => {
    const h = harness();
    const { agent } = scene(h);
    const secret = h.store.createSpace('secret').id;
    expectStoreError(() => h.store.listAgentsSharingSpaceWith(agent, secret), 'not_found');
  });
});

describe('escalations', () => {
  it('records, lists and marks notification state', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const conversation = h.store.resolveOrCreateConversation(space, 'notes').id;
    const { escalation } = h.store.recordEscalation({
      agent,
      conversation,
      reason: 'looks wrong',
      idempotencyKey: key('e1'),
    });

    expect(escalation.notificationState).toBe('pending');
    expect(h.store.listEscalations({ state: 'pending' })).toHaveLength(1);

    h.advance(30);
    const failed = h.store.markEscalationNotification(escalation.id, 'failed', {
      error: 'connect ECONNREFUSED',
      nextAttemptAt: '2026-01-01T00:01:00.000Z' as Timestamp,
    });
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe('connect ECONNREFUSED');
    expect(h.store.listEscalations({ state: 'pending' })).toHaveLength(0);

    const sent = h.store.markEscalationNotification(escalation.id, 'sent');
    expect(sent.attempts).toBe(2);
    expect(sent.notificationState).toBe('sent');
  });

  it('refuses an escalation about a conversation the agent cannot see', () => {
    const h = harness();
    const { agent } = scene(h);
    const secret = h.store.createSpace('secret').id;
    const conversation = h.store.resolveOrCreateConversation(secret, 'notes').id;
    expectStoreError(
      () =>
        h.store.recordEscalation({
          agent,
          conversation,
          reason: 'looks wrong',
          idempotencyKey: key('e1'),
        }),
      'not_found',
    );
  });
});

describe('sessions', () => {
  it('creates, verifies, expires and deletes', () => {
    const h = harness();
    const issued = h.store.createSession(3600);
    expect(h.store.verifySession(issued.token)?.id).toBe(issued.id);

    const stored = h.store.database.prepare('SELECT token_hash FROM session').get() as {
      token_hash: string;
    };
    expect(stored.token_hash).not.toBe(issued.token);

    h.advance(3601);
    expect(h.store.verifySession(issued.token)).toBeUndefined();
    expect(h.store.deleteExpiredSessions()).toBe(1);

    const second = h.store.createSession(3600);
    expect(h.store.deleteSession(second.token)).toBe(true);
    expect(h.store.verifySession(second.token)).toBeUndefined();
  });
});

describe('posting', () => {
  it('refuses a space the agent is not in, and says not found', () => {
    const h = harness();
    const { agent } = scene(h);
    const secret = h.store.createSpace('secret').id;
    expectStoreError(() => post(h, agent, secret, 'notes', 'hello'), 'not_found');
  });

  it('lets the human post anywhere, attributed by configuration', () => {
    const h = harness();
    const { space } = scene(h);
    const posted = h.store.postMessage({
      sender: { kind: 'human' },
      target: { space, title: 'notes' },
      body: 'hello',
    });
    expect(posted.message.sender).toEqual({ kind: 'human', displayName: 'the human' });
  });

  it('carries attachments and resolves them by id', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const posted = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'see attached',
      attachments: [
        {
          id: 'attachment0000a' as AttachmentId,
          filename: 'report.csv',
          contentType: 'text/csv',
          sizeBytes: 42,
        },
      ],
    });
    expect(posted.message.attachments).toHaveLength(1);
    expect(h.store.getAttachment('attachment0000a' as AttachmentId)?.message).toBe(
      posted.message.id,
    );
  });

  it('refuses an empty body with no attachment', () => {
    const h = harness();
    const { agent, space } = scene(h);
    expectStoreError(() => post(h, agent, space, 'notes', '   '), 'invalid_request');
  });
});

// ---------------------------------------------------------------------------

describe('reading backwards', () => {
  /** Five messages a minute apart, and the instant each one was written. */
  function thread(h: Harness): {
    agent: AgentId;
    space: SpaceId;
    conversation: ConversationId;
    at: Record<string, Timestamp>;
  } {
    const { agent, space } = scene(h);
    const at: Record<string, Timestamp> = {};
    for (const body of ['one', 'two', 'three', 'four', 'five']) {
      h.advance(60);
      at[body] = h.at();
      post(h, agent, space, 'notes', body);
    }
    const conversation = h.store.listConversationSummaries(space)[0]?.id ?? ('' as ConversationId);
    return { agent, space, conversation, at };
  }

  const reader = (agent: AgentId): { kind: 'agent'; id: AgentId } => ({ kind: 'agent', id: agent });

  it('pages a conversation backwards from the end, newest first', () => {
    const h = harness();
    const { agent, conversation } = thread(h);

    const first = h.store.readConversation(reader(agent), conversation, { order: 'newest' }, 2);
    // The page reads in the order that was asked for: the first message on it
    // is the newest, so an agent wanting the last two has them without
    // reversing anything or counting from an end it cannot see.
    expect(first.messages.map((m) => m.body)).toEqual(['five', 'four']);
    expect(first.hasMore).toBe(true);

    // `after` continues in the direction of travel: older than the last one
    // handed over.
    const second = h.store.readConversation(
      reader(agent),
      conversation,
      { order: 'newest', after: first.nextCursor },
      2,
    );
    expect(second.messages.map((m) => m.body)).toEqual(['three', 'two']);
    expect(second.hasMore).toBe(true);

    const third = h.store.readConversation(
      reader(agent),
      conversation,
      { order: 'newest', after: second.nextCursor },
      2,
    );
    expect(third.messages.map((m) => m.body)).toEqual(['one']);
    // Nothing older left, so this is the end of the walk.
    expect(third.hasMore).toBe(false);

    const fourth = h.store.readConversation(
      reader(agent),
      conversation,
      { order: 'newest', after: third.nextCursor },
      2,
    );
    expect(fourth.messages).toEqual([]);
    // A query skips nothing, backwards as well as forwards, so an empty page
    // leaves the position untouched.
    expect(fourth.nextCursor).toBe(third.nextCursor);
  });

  it('pages a space backwards too, and covers exactly what paging forwards covers', () => {
    const h = harness();
    const { agent, space } = thread(h);

    const forwards: string[] = [];
    let cursor = undefined as undefined | ReturnType<typeof h.store.readSpace>['nextCursor'];
    // Bounded: a page that never stops advancing is a bug to fail on, not to
    // hang on.
    for (let guard = 0; guard < 10; guard += 1) {
      const page = h.store.readSpace(
        reader(agent),
        space,
        cursor === undefined ? undefined : { after: cursor },
        2,
      );
      forwards.push(...page.messages.map((m) => m.body));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }

    const backwards: string[] = [];
    let back = undefined as undefined | typeof cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = h.store.readSpace(
        reader(agent),
        space,
        back === undefined ? { order: 'newest' } : { order: 'newest', after: back },
        2,
      );
      backwards.push(...page.messages.map((m) => m.body));
      back = page.nextCursor;
      if (!page.hasMore) break;
    }

    expect(forwards).toEqual(['one', 'two', 'three', 'four', 'five']);
    // The same messages from the other end: order is which way you walk, not
    // which messages are in range.
    expect(backwards).toEqual([...forwards].reverse());
  });

  it('bounds a backwards read by since and until, like a forwards one', () => {
    const h = harness();
    const { agent, space, at } = thread(h);
    const range = { since: at['two'] as Timestamp, until: at['five'] as Timestamp };

    expect(h.store.readSpace(reader(agent), space, range).messages.map((m) => m.body)).toEqual([
      'two',
      'three',
      'four',
    ]);
    // since is still inclusive and until still exclusive; only the direction
    // of travel changed.
    expect(
      h.store
        .readSpace(reader(agent), space, { ...range, order: 'newest' })
        .messages.map((m) => m.body),
    ).toEqual(['four', 'three', 'two']);

    // And paging backwards inside a range stops at the range, not at the
    // conversation's first day.
    const page = h.store.readSpace(reader(agent), space, { ...range, order: 'newest' }, 2);
    expect(page.messages.map((m) => m.body)).toEqual(['four', 'three']);
    expect(page.hasMore).toBe(true);
    const rest = h.store.readSpace(
      reader(agent),
      space,
      { ...range, order: 'newest', after: page.nextCursor },
      2,
    );
    expect(rest.messages.map((m) => m.body)).toEqual(['two']);
    expect(rest.hasMore).toBe(false);
  });

  it('starts at the end as it stood when the read began', () => {
    const h = harness();
    const { agent, space, conversation } = thread(h);

    const page = h.store.readConversation(reader(agent), conversation, { order: 'newest' }, 2);
    post(h, agent, space, 'notes', 'six');

    // Resuming continues backwards through the history the first page was
    // taken from. A message written since is newer than the whole walk, so it
    // is not something paging backwards can reach.
    const next = h.store.readConversation(
      reader(agent),
      conversation,
      { order: 'newest', after: page.nextCursor },
      2,
    );
    expect(next.messages.map((m) => m.body)).toEqual(['three', 'two']);
  });

  it('returns an empty page with a usable cursor for a thread with nothing in it', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const empty = h.store.resolveOrCreateConversation(space, 'silence').id;

    const page = h.store.readConversation(reader(agent), empty, { order: 'newest' });
    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
    post(h, agent, space, 'silence', 'first thing');
    // The cursor was the end of an empty thread, so resuming from it still
    // finds nothing older — it is a position, not a subscription.
    expect(
      h.store.readConversation(reader(agent), empty, { order: 'newest', after: page.nextCursor })
        .messages,
    ).toEqual([]);
  });

  it('records the order it read in, like every other parameter', () => {
    const h = harness();
    const { agent, space } = thread(h);
    h.store.readSpace(reader(agent), space, { order: 'newest' }, 2);
    expect(h.store.readReadLog({ agent }).entries[0]?.params).toMatchObject({
      range: { order: 'newest' },
    });
  });

  it('refuses an order it does not know rather than reading forwards', () => {
    const h = harness();
    const { agent, space } = thread(h);
    expectStoreError(
      () => h.store.readSpace(reader(agent), space, { order: 'sideways' as 'newest' }),
      'invalid_request',
    );
  });
});

describe('the read log is paged', () => {
  function reads(h: Harness, agent: AgentId, space: SpaceId, count: number): void {
    for (let i = 0; i < count; i += 1) {
      h.store.readSpace({ kind: 'agent', id: agent }, space);
    }
  }

  it('pages newest first without repeating or skipping a row', () => {
    const h = harness();
    const { agent, space } = scene(h);
    // All five in the same millisecond: read_at alone cannot order them, and a
    // cursor that only carried the timestamp would either repeat or skip.
    reads(h, agent, space, 5);

    const all = h.store.readReadLog({ agent }).entries;
    expect(all).toHaveLength(5);

    const seen: string[] = [];
    let cursor: ReadLogCursor | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: ReturnType<Store['readReadLog']> = h.store.readReadLog({
        agent,
        limit: 2,
        ...(cursor === null ? {} : { after: cursor }),
      });
      expect(page.entries.length).toBeLessThanOrEqual(2);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(all.map((e) => e.id));
    expect(new Set(seen).size).toBe(5);
  });

  it('leaves an exhausted page where it was, and is stable against later reads', () => {
    const h = harness();
    const { agent, space } = scene(h);
    reads(h, agent, space, 3);
    const original = h.store.readReadLog({ agent }).entries.map((e) => e.id);

    const first = h.store.readReadLog({ agent, limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual(original.slice(0, 2));

    // The log keeps growing between pages — it is the fastest-growing table
    // here. Keyset paging means the second page is still the third row, not
    // whatever an offset now points at.
    h.advance(60);
    reads(h, agent, space, 4);

    const second = h.store.readReadLog({ agent, limit: 2, after: first.nextCursor ?? undefined });
    expect(second.entries.map((e) => e.id)).toEqual(original.slice(2));
    expect(second.hasMore).toBe(false);

    const third = h.store.readReadLog({
      agent,
      limit: 2,
      after: second.nextCursor ?? undefined,
    });
    expect(third.entries).toEqual([]);
    expect(third.nextCursor).toBe(second.nextCursor);
  });

  it('bounds the log by time, inclusive at since and exclusive at until', () => {
    const h = harness();
    const { agent, space } = scene(h);
    reads(h, agent, space, 1);
    h.advance(60);
    const middle = h.at();
    reads(h, agent, space, 1);
    h.advance(60);
    const end = h.at();
    reads(h, agent, space, 1);

    const window = h.store.readReadLog({ agent, since: middle, until: end });
    expect(window.entries).toHaveLength(1);
    expect(window.entries[0]?.readAt).toBe(middle);
    expect(h.store.readReadLog({ agent, since: end }).entries).toHaveLength(1);
    expect(h.store.readReadLog({ agent, until: end }).entries).toHaveLength(2);
  });

  it('still filters by agent, and a cursor from one agent does not cross to another', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const bob = h.store.createAgent('bob').id;
    h.store.grantMembership(bob, space);
    reads(h, agent, space, 2);
    h.advance(60);
    h.store.readSpace({ kind: 'agent', id: bob }, space);

    expect(h.store.readReadLog({ agent }).entries.every((e) => e.agent === agent)).toBe(true);
    expect(h.store.readReadLog().entries).toHaveLength(3);
    expect(h.store.readReadLog({ agent: bob }).entries).toHaveLength(1);

    // Bob's read is the newest, so continuing from it inside alice's filter
    // yields alice's rows and nothing of bob's.
    const bobPage = h.store.readReadLog({ agent: bob });
    const after = h.store.readReadLog({ agent, after: bobPage.nextCursor as ReadLogCursor });
    expect(after.entries).toHaveLength(2);
    expect(after.entries.every((e) => e.agent === agent)).toBe(true);
  });

  it('refuses a cursor that is not one of its own', () => {
    const h = harness();
    const { agent, space } = scene(h);
    reads(h, agent, space, 1);
    const stream = h.store.readStream(agent);
    expectStoreError(
      () => h.store.readReadLog({ after: stream.nextCursor as unknown as ReadLogCursor }),
      'invalid_request',
    );
  });
});

describe('attachments carry their space', () => {
  it('says which space authorises the download, without a second lookup', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const id = newAttachmentId();
    const posted = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'see attached',
      attachments: [{ id, filename: 'report.csv', contentType: 'text/csv', sizeBytes: 42 }],
    });

    const record = h.store.getAttachment(id);
    expect(record?.message).toBe(posted.message.id);
    // The join already selected it; withholding it only bought the caller a
    // getMessage call to learn what it had already read.
    expect(record?.space).toBe(space);
  });

  it('mints ids from the store rather than from whoever is calling it', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = newAttachmentId();
    expect(first).toMatch(/^[0-9a-hjkmnp-tv-z]{16}$/);
    expect(newAttachmentId()).not.toBe(first);

    // And what it mints is what `AttachmentInput` wants, with no cast at the
    // call site.
    const posted = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'see attached',
      attachments: [{ id: first, filename: 'a.txt', contentType: 'text/plain', sizeBytes: 1 }],
    });
    expect(posted.message.attachments[0]?.id).toBe(first);
  });
});

describe('search', () => {
  it('reports a malformed query as an invalid request, not a database fault', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'hello world');

    for (const malformed of ['"', 'hello AND', 'NEAR(', '']) {
      const error = expectStoreError(() => h.store.searchMessages(malformed), 'invalid_request');
      expect(error.message).toMatch(/FTS5/i);
    }
  });

  it('does not rewrite a query into one that parses', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'hello world');

    // The quoted phrase is honoured as a phrase, and the unbalanced quote is
    // refused rather than dropped — which would have turned it into this.
    expect(h.store.searchMessages('"hello world"')).toHaveLength(1);
    expect(h.store.searchMessages('"world hello"')).toHaveLength(0);
    expectStoreError(() => h.store.searchMessages('"hello world'), 'invalid_request');
  });
});

describe('conversation summaries', () => {
  it('counts, dates and attributes each thread in a space', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const bob = h.store.createAgent('bob').id;
    h.store.grantMembership(bob, space);

    post(h, agent, space, 'alpha', 'one');
    h.advance(60);
    post(h, bob, space, 'beta', 'two');
    h.advance(60);
    post(h, agent, space, 'alpha', 'three');
    h.advance(60);
    const lastAt = h.at();
    h.store.postMessage({
      sender: { kind: 'human' },
      target: { space, title: 'beta' },
      body: 'four',
    });
    const empty = h.store.resolveOrCreateConversation(space, 'gamma');

    const summaries = h.store.listConversationSummaries(space);
    // Most recently active first: a thread list is a list of what happened
    // last, and a thread nobody has posted to has not happened at all.
    expect(summaries.map((s) => s.title)).toEqual(['beta', 'alpha', 'gamma']);

    const beta = summaries[0];
    expect(beta?.messageCount).toBe(2);
    expect(beta?.lastActivityAt).toBe(lastAt);
    expect(beta?.lastSender).toEqual({ kind: 'human', displayName: 'the human' });

    const alpha = summaries[1];
    expect(alpha?.messageCount).toBe(2);
    expect(alpha?.lastSender).toEqual({ kind: 'agent', id: agent, displayName: 'alice' });

    const gamma = summaries[2];
    expect(gamma?.id).toBe(empty.id);
    expect(gamma?.messageCount).toBe(0);
    expect(gamma?.lastActivityAt).toBeNull();
    expect(gamma?.lastSender).toBeNull();
  });

  it('renders the sender name at read time, like every other label', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'alpha', 'one');
    h.store.renameAgent(agent, 'alice2');
    expect(h.store.listConversationSummaries(space)[0]?.lastSender).toEqual({
      kind: 'agent',
      id: agent,
      displayName: 'alice2',
    });
  });

  it('does not reach across spaces', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const other = h.store.createSpace('other').id;
    h.store.grantMembership(agent, other);
    post(h, agent, space, 'alpha', 'one');
    post(h, agent, other, 'beta', 'two');

    expect(h.store.listConversationSummaries(space).map((s) => s.title)).toEqual(['alpha']);
    expect(h.store.listConversationSummaries(other).map((s) => s.title)).toEqual(['beta']);
    expectStoreError(
      () => h.store.listConversationSummaries('nosuchspace00000' as SpaceId),
      'not_found',
    );
  });
});

describe('replaying an idempotency key', () => {
  function postWithKey(
    h: Harness,
    agent: AgentId,
    space: SpaceId,
    k: IdempotencyKey,
    attachment?: { id: AttachmentId; filename?: string; digest?: string },
  ): ReturnType<Store['postMessage']> {
    return h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'the report',
      idempotencyKey: k,
      ...(attachment === undefined
        ? {}
        : {
            attachments: [
              {
                id: attachment.id,
                filename: attachment.filename ?? 'report.csv',
                contentType: 'text/csv',
                sizeBytes: 42,
                ...(attachment.digest === undefined ? {} : { contentDigest: attachment.digest }),
              },
            ],
          }),
    });
  }

  it('follows current access, so a revoked agent cannot read a space back', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = postWithKey(h, agent, space, key('k1'));
    expect(first.created).toBe(true);

    h.store.revokeMembership(agent, space);

    // A replay hands back a rendered message — body, title, sender,
    // attachment metadata. Returning it here would be a way for an agent to
    // recover a space it has lost, using keys it minted itself.
    expectStoreError(() => postWithKey(h, agent, space, key('k1')), 'not_found');
    // Indistinguishable from a space that never existed.
    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'agent', id: agent },
          target: { space: 'nosuchspace00000' as SpaceId, title: 'notes' },
          body: 'the report',
          idempotencyKey: key('k1'),
        }),
      'not_found',
    );

    // And nothing was written in the meantime: the key still covers the one
    // message it always did.
    h.store.grantMembership(agent, space);
    const replay = postWithKey(h, agent, space, key('k1'));
    expect(replay.created).toBe(false);
    expect(replay.message.id).toBe(first.message.id);
  });

  it('hides a mismatched request behind the same not found, once access is gone', () => {
    const h = harness();
    const { agent, space } = scene(h);
    postWithKey(h, agent, space, key('k1'));
    h.store.revokeMembership(agent, space);

    // Not `invalid_request`: whether a key was used for this request or some
    // other one is something only a reader of that space may learn.
    expectStoreError(
      () =>
        h.store.postMessage({
          sender: { kind: 'agent', id: agent },
          target: { space, title: 'notes' },
          body: 'something else entirely',
          idempotencyKey: key('k1'),
        }),
      'not_found',
    );
  });

  it('replays a retried upload, whose attachment ids are new every time', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = postWithKey(h, agent, space, key('k1'), { id: newAttachmentId() });

    // The retry streamed the same file to the volume again and minted a fresh
    // id for it, because that is what writing the file before the row commits
    // requires. Same request all the same.
    const retry = postWithKey(h, agent, space, key('k1'), { id: newAttachmentId() });
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.message.attachments).toEqual(first.message.attachments);

    // What the caller stated about the file is still part of the request.
    expectStoreError(
      () =>
        postWithKey(h, agent, space, key('k1'), {
          id: newAttachmentId(),
          filename: 'something-else.csv',
        }),
      'invalid_request',
    );
  });

  it('applies the same rule to a replayed escalation', () => {
    const h = harness();
    const { agent, space } = scene(h);
    post(h, agent, space, 'notes', 'one');
    const conversation = h.store.listConversationSummaries(space)[0]?.id ?? ('' as ConversationId);
    const first = h.store.recordEscalation({
      agent,
      conversation,
      reason: 'the numbers do not add up',
      idempotencyKey: key('e1'),
    });
    expect(first.created).toBe(true);

    h.store.revokeMembership(agent, space);
    expectStoreError(
      () =>
        h.store.recordEscalation({
          agent,
          conversation,
          reason: 'the numbers do not add up',
          idempotencyKey: key('e1'),
        }),
      'not_found',
    );
  });

  it('tells two files of the same shape apart when the caller digests them', () => {
    const h = harness();
    const { agent, space } = scene(h);
    postWithKey(h, agent, space, key('k1'), { id: newAttachmentId(), digest: 'sha256:aaa' });

    expect(
      postWithKey(h, agent, space, key('k1'), { id: newAttachmentId(), digest: 'sha256:aaa' })
        .created,
    ).toBe(false);
    // Same name, same type, same size, different bytes: a different request.
    expectStoreError(
      () =>
        postWithKey(h, agent, space, key('k1'), { id: newAttachmentId(), digest: 'sha256:bbb' }),
      'invalid_request',
    );
  });
});
