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
import type { EscalationCursor, SearchCursor } from './index.js';
import { StoreError } from './errors.js';
import {
  newAttachmentId,
  openStore,
  type CollapseResume,
  type Reader,
  type ReadLogCursor,
  type Store,
} from './index.js';
import { referenceToken, RESERVED_SEQUENCE } from './text.js';

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

  // Raw SQL on purpose: this proves the partial unique index itself, which
  // the public API cannot reach — the API's own guard is tested above. It is
  // defence in depth at the schema level, not a test smell to clean up.
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

describe('operator descriptions', () => {
  it('appends normalized values and derives the current value, with empty meaning absent', () => {
    const h = harness();
    const { agent, space } = scene(h);

    h.store.setSpaceDescription(space, '  A place\n\tfor work  ');
    expect(h.store.getSpaceDescription(space)).toBe('A place for work');
    h.store.setSpaceDescription(space, 'replacement');
    expect(h.store.getSpaceDescription(space)).toBe('replacement');
    h.store.setSpaceDescription(space, '   ');
    expect(h.store.getSpaceDescription(space)).toBeUndefined();

    const rows = h.store.database
      .prepare('SELECT body FROM description WHERE kind = ? AND subject_id = ? ORDER BY seq')
      .all('space', space) as { body: string }[];
    expect(rows.map((row) => row.body)).toEqual(['A place for work', 'replacement', '']);

    h.store.setMembershipNote(agent, space, 'specific reason');
    expect(h.store.getMembershipNote(agent, space)).toBe('specific reason');
  });

  it('rejects overlong descriptions and notes for closed memberships', () => {
    const h = harness();
    const { agent, space } = scene(h);
    expectStoreError(() => h.store.setAgentDescription(agent, 'x'.repeat(1001)), 'invalid_request');
    h.store.revokeMembership(agent, space);
    const error = expectStoreError(
      () => h.store.setMembershipNote(agent, space, 'too late'),
      'invalid_request',
    );
    expect(error.message).toContain('open membership');
  });
});

describe('human catch-up marks', () => {
  it('advances marks forward only and lists unread conversations newest first', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = post(h, agent, space, 'older', 'one');
    h.advance(1);
    post(h, agent, space, 'newer', 'two');
    const older = h.store.getConversation(first.conversation) as NonNullable<
      ReturnType<Store['getConversation']>
    >;

    expect(h.store.listHumanCatchUp({ limit: 10 }).conversations.map((row) => row.title)).toEqual([
      'newer',
      'older',
    ]);
    const olderTip = h.store
      .listHumanCatchUp({ limit: 10 })
      .conversations.find((row) => row.id === older.id)!.latestActivitySeq;
    expect(h.store.advanceHumanReadMark(older.id, olderTip)).toBe(true);
    expect(h.store.advanceHumanReadMark(older.id, olderTip - 1)).toBe(false);
    expect(h.store.listHumanCatchUp({ limit: 10 }).conversations.map((row) => row.title)).toEqual([
      'newer',
    ]);

    post(h, agent, space, 'older', 'three');
    const row = h.store
      .listHumanCatchUp({ limit: 10 })
      .conversations.find((item) => item.id === older.id);
    expect(row).toMatchObject({ unreadCount: 1, latestActivityAt: h.at() });
  });

  it('includes completed threads only with unread activity, reports pins, and pages', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const quiet = post(h, agent, space, 'quiet', 'done');
    h.store.completeConversation({ kind: 'human' }, quiet.conversation);
    const quietTip = h.store.listHumanCatchUp().conversations[0]!.latestActivitySeq;
    h.store.advanceHumanReadMark(quiet.conversation, quietTip);

    const active = post(h, agent, space, 'active', 'read me');
    h.store.pinMessage({ kind: 'human' }, active.conversation, active.id);
    h.store.completeConversation({ kind: 'human' }, active.conversation);
    const first = h.store.listHumanCatchUp({ limit: 1 });
    expect(first.conversations).toHaveLength(1);
    expect(first.conversations[0]).toMatchObject({
      title: 'active',
      unreadCount: 1,
      hasPins: true,
      status: 'complete',
    });
    expect(first.hasMore).toBe(false);
    expect(h.store.listSpaceSummaries()).toEqual([
      expect.objectContaining({ id: space, unreadCount: 1 }),
    ]);
  });
});

describe('conversation annotations', () => {
  it('derives sticky status and one movable pin per actor, including as-of state', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = post(h, agent, space, 'decision', 'first');
    const conversation = first.conversation;

    expect(h.store.getConversationAnnotations(conversation)).toEqual({ status: 'open', pins: [] });
    h.store.completeConversation({ kind: 'agent', id: agent }, conversation);
    h.store.pinMessage({ kind: 'agent', id: agent }, conversation, first.id);
    const tip = h.store.database
      .prepare('SELECT MAX(seq) AS seq FROM conversation_annotation')
      .get() as { seq: number };
    const second = post(h, agent, space, 'decision', 'second');
    h.store.pinMessage({ kind: 'agent', id: agent }, conversation, second.id);

    expect(h.store.getConversationAnnotations(conversation)).toMatchObject({
      status: 'complete',
      pins: [{ message: second.id, actor: { kind: 'agent', id: agent } }],
    });
    expect(h.store.getConversationAnnotationsAsOf(conversation, tip.seq)).toMatchObject({
      status: 'complete',
      pins: [{ message: first.id, actor: { kind: 'agent', id: agent } }],
    });
    expect(
      h.store.postMessage({
        sender: { kind: 'agent', id: agent },
        target: { conversation },
        body: 'still complete',
      }).annotations.status,
    ).toBe('complete');
  });

  it('enforces access and pin target, and idempotent no-ops append nothing', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const outsider = h.store.createAgent('outsider').id;
    const message = post(h, agent, space, 'decision', 'one');
    const conversation = message.conversation;
    expectStoreError(
      () => h.store.completeConversation({ kind: 'agent', id: outsider }, conversation),
      'not_found',
    );

    const otherSpace = h.store.createSpace('other').id;
    h.store.grantMembership(agent, otherSpace);
    const other = post(h, agent, otherSpace, 'other', 'wrong target');
    expectStoreError(
      () => h.store.pinMessage({ kind: 'agent', id: agent }, conversation, other.id),
      'not_found',
    );

    expect(h.store.completeConversation({ kind: 'agent', id: agent }, conversation)).toBe(true);
    expect(h.store.completeConversation({ kind: 'agent', id: agent }, conversation)).toBe(false);
    expect(h.store.unpinConversation({ kind: 'agent', id: agent }, conversation)).toBe(false);
    expect(
      h.store.database.prepare('SELECT COUNT(*) AS n FROM conversation_annotation').get(),
    ).toEqual({ n: 1 });
  });

  it('applies complete and pin atomically with a post', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const result = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'summary' },
      body: 'the answer',
      complete: true,
      pin: true,
    });
    expect(result.annotations).toMatchObject({
      status: 'complete',
      pins: [{ message: result.message.id, actor: { kind: 'agent', id: agent } }],
    });
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
    expect(h.store.listEscalations().escalations).toHaveLength(1);

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

    expect(stored.body).toBe(`ping ${referenceToken(bob)} please`);
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

  it('keeps literal text that spells an agent id literal, for ever', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const bob = h.store.createAgent('bob').id;
    h.store.grantMembership(bob, space);

    // Hand-written ids — bare, and followed by a letter — are what the author
    // typed, not references. Bob being in the space changes nothing: the
    // encoding is decided at write time.
    const posted = post(h, agent, space, 'notes', `see @${bob} and @${bob}i`);
    const stored = h.store.database
      .prepare('SELECT body FROM message WHERE id = ?')
      .get(posted.id) as { body: string };
    expect(stored.body).toBe(`see @${bob} and @${bob}i`);
    expect(posted.body).toBe(`see @${bob} and @${bob}i`);
    expect(posted.mentions).toEqual([]);

    h.store.renameAgent(bob, 'robert');
    const reread = h.store.readSpace({ kind: 'agent', id: agent }, space).messages[0];
    expect(reread?.body).toBe(`see @${bob} and @${bob}i`);
  });

  it('never lets the reference marker reach a rendered body or snippet', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const bob = h.store.createAgent('bob').id;
    h.store.grantMembership(bob, space);

    const posted = post(h, agent, space, 'notes', 'ping @bob about the figures');
    expect(posted.body).not.toContain(RESERVED_SEQUENCE);

    const { hits } = h.store.searchMessages('figures');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).not.toContain(RESERVED_SEQUENCE);
    expect(hits[0]?.snippet).toContain('@bob');
    expect(hits[0]?.message.body).toBe('ping @bob about the figures');

    // The token is still searchable by the bare id, and the highlighted id
    // renders as the highlighted name rather than a bracketed id.
    const { hits: byId } = h.store.searchMessages(bob);
    expect(byId).toHaveLength(1);
    expect(byId[0]?.snippet).toBe('ping @[bob] about the figures');
    expect(byId[0]?.snippet).not.toContain(RESERVED_SEQUENCE);
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

    expect(h.store.searchMessages(`"${bob}"`).hits).toHaveLength(1);
    expect(h.store.searchMessages('invoices').hits).toHaveLength(1);

    h.store.renameAgent(bob, 'robert');
    expect(h.store.searchMessages(`"${bob}"`).hits).toHaveLength(1);
    expect(h.store.searchMessages('robert').hits).toHaveLength(0);
  });
});

describe('the reserved control character', () => {
  const poison = `before${RESERVED_SEQUENCE}after`;

  // The value ADR-0010 and every agent's delimiter depend on; the rest of the
  // suite uses the symbol and would not notice it changing.
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

  it('stands for one read until a sweep says otherwise', () => {
    const h = harness();
    const { agent, space } = scene(h);
    h.store.readSpace({ kind: 'agent', id: agent }, space);
    const entry = h.store.readReadLog({ agent }).entries[0];
    expect(entry?.collapsedCount).toBe(1);
    expect(entry?.firstReadAt).toBeUndefined();
  });
});

describe('a read is bounded by the stream tip it recorded', () => {
  it('excludes a message written in the same millisecond as the read', () => {
    const h = harness();
    const { agent, space } = scene(h);
    // The clock never moves here: the read and both messages share a
    // millisecond, so only a sequence bound can separate them.
    const first = post(h, agent, space, 'daily', 'before the read');
    h.store.readStream(agent);
    const read = h.store.readReadLog({ agent }).entries[0];
    post(h, agent, space, 'daily', 'after the read');

    const page = h.store.readConversationAsOf(read?.id ?? '', first.conversation);
    expect(page?.messages.map((m) => m.body)).toEqual(['before the read']);
    expect(h.store.readConversation({ kind: 'human' }, first.conversation).messages).toHaveLength(
      2,
    );
  });

  it('still honours a narrower until of the callers own', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = post(h, agent, space, 'daily', 'one');
    h.advance(60);
    const between = h.at();
    post(h, agent, space, 'daily', 'two');
    h.advance(60);
    h.store.readStream(agent);
    const read = h.store.readReadLog({ agent }).entries[0]?.id ?? '';

    expect(
      h.store.readConversationAsOf(read, first.conversation)?.messages.map((m) => m.body),
    ).toEqual(['one', 'two']);
    expect(
      h.store
        .readConversationAsOf(read, first.conversation, { until: between })
        ?.messages.map((m) => m.body),
    ).toEqual(['one']);
  });

  it('shows nothing for a read taken before the agent joined any space', () => {
    const h = harness();
    // The onboarding order: the agent exists and is polling before the human
    // puts it anywhere, so its first read saw an empty stream and recorded a
    // tip of 0. A grant is itself a sequenced event, so a tip of 0 is a read
    // taken when the agent belonged to nothing.
    const agent = h.store.createAgent('alice').id;
    h.store.readStream(agent);
    const read = h.store.readReadLog({ agent }).entries[0]?.id ?? '';

    const space = h.store.createSpace('acme').id;
    h.store.grantMembership(agent, space);
    const posted = post(h, agent, space, 'daily', 'after the read');

    // At that read the agent could see no space at all, so the reconstruction
    // is not-found rather than an empty page: it answers what the agent could
    // have seen, and the answer here is nothing.
    expect(h.store.readConversationAsOf(read, posted.conversation)).toBeUndefined();
    expect(h.store.readConversation({ kind: 'human' }, posted.conversation).messages).toHaveLength(
      1,
    );
  });

  it('falls back to the millisecond bound for a row that recorded no tip', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = post(h, agent, space, 'daily', 'before the read');
    h.store.readStream(agent);
    const read = h.store.readReadLog({ agent }).entries[0]?.id ?? '';
    post(h, agent, space, 'daily', 'after the read');
    // What migration 0004 leaves on every row 0003 back-filled: unknown.
    h.store.database.prepare('UPDATE read_log SET tip_seq = NULL').run();

    // Coarse again, and visibly so: the later message shares the millisecond
    // and comes back.
    expect(
      h.store.readConversationAsOf(read, first.conversation)?.messages.map((m) => m.body),
    ).toEqual(['before the read', 'after the read']);
  });
});

describe('a read only reconstructs a space the agent could see then', () => {
  it('shows nothing from a space the agent was never in', () => {
    const h = harness();
    const alice = h.store.createAgent('alice').id;
    const bob = h.store.createAgent('bob').id;
    const acme = h.store.createSpace('acme').id;
    const other = h.store.createSpace('other').id;
    h.store.grantMembership(alice, acme);
    h.store.grantMembership(bob, other);
    // A thread alice was never near, and an ordinary read of her own space to
    // hang the reconstruction on.
    const secret = post(h, bob, other, 'plans', 'bob only');
    post(h, alice, acme, 'daily', 'alice here');
    h.store.readSpace({ kind: 'agent', id: alice }, acme);
    const read = h.store.readReadLog({ agent: alice }).entries[0]?.id ?? '';

    // The read is alice's; she held no membership in `other` at that moment,
    // so she could have seen nothing of it and the reconstruction is not-found.
    expect(h.store.readConversationAsOf(read, secret.conversation)).toBeUndefined();
  });

  it('shows nothing when the membership was revoked before the read', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = post(h, agent, space, 'daily', 'while a member');
    h.advance(60);
    h.store.revokeMembership(agent, space);
    h.advance(60);
    // A later read, taken after the agent had left the space. The revocation is
    // a sequenced event, so it falls at or below the tip this read records.
    h.store.readStream(agent);
    const read = h.store.readReadLog({ agent }).entries[0]?.id ?? '';

    expect(h.store.readConversationAsOf(read, first.conversation)).toBeUndefined();
  });

  it('shows the page when the agent was a member at the read, even if later revoked', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = post(h, agent, space, 'daily', 'in the room');
    h.store.readSpace({ kind: 'agent', id: agent }, space);
    const read = h.store.readReadLog({ agent }).entries[0]?.id ?? '';
    // Leaving afterwards does not rewrite what the read could have seen: the
    // membership interval was open at the tip the read recorded.
    h.advance(60);
    h.store.revokeMembership(agent, space);

    expect(
      h.store.readConversationAsOf(read, first.conversation)?.messages.map((m) => m.body),
    ).toEqual(['in the room']);
  });

  it('keeps a legacy row visible when the revocation shares the read millisecond', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const first = post(h, agent, space, 'daily', 'in the room');
    // Read and revoke in the same millisecond: the clock never moves between
    // them, so `revoked_at` equals `read_at` to the millisecond.
    h.store.readSpace({ kind: 'agent', id: agent }, space);
    const read = h.store.readReadLog({ agent }).entries[0]?.id ?? '';
    h.store.revokeMembership(agent, space);
    // A row that recorded no tip falls back to the millisecond clock; the coarse
    // bound includes a message in the read's own millisecond, so a revocation in
    // that same millisecond must not hide the conversation the message shows.
    h.store.database.prepare('UPDATE read_log SET tip_seq = NULL').run();

    expect(
      h.store.readConversationAsOf(read, first.conversation)?.messages.map((m) => m.body),
    ).toEqual(['in the room']);
  });
});

describe('the wording of a read is reproducible after renames', () => {
  const reader = (agent: AgentId): Reader => ({ kind: 'agent', id: agent });
  const newestRead = (h: Harness, agent: AgentId): string =>
    h.store.readReadLog({ agent }).entries[0]?.id ?? '';

  it('renders a whole page as it read at the time', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const posted = post(h, agent, space, 'daily', 'first');
    h.store.readConversation(reader(agent), posted.conversation);
    const read = newestRead(h, agent);
    h.store.renameConversation(posted.conversation, 'weekly');
    h.store.renameAgent(agent, 'alicia');

    const then = h.store.readConversationAsOf(read, posted.conversation);
    expect(then?.messages.map((m) => [m.conversationTitle, m.sender.displayName])).toEqual([
      ['daily', 'alice'],
    ]);
    expect(
      h.store.readConversation({ kind: 'human' }, posted.conversation).messages[0],
    ).toMatchObject({ conversationTitle: 'weekly' });
    // Not a read: the log is unchanged.
    expect(h.store.readReadLog({ agent }).entries).toHaveLength(1);

    // Ends at the read: a message sent afterwards was not on that page and
    // is not shown with old labels as if it were.
    h.advance(1);
    post(h, agent, space, 'weekly', 'later');
    expect(h.store.readConversationAsOf(read, posted.conversation)?.messages).toHaveLength(1);
    expect(h.store.readConversation({ kind: 'human' }, posted.conversation).messages).toHaveLength(
      2,
    );
    expect(h.store.readConversationAsOf('nope', posted.conversation)).toBeUndefined();
    expect(h.store.readConversationAsOf(read, 'nope' as ConversationId)).toBeUndefined();
    expect(h.store.getRead(read)?.kind).toBe('conversation');
    expect(h.store.getRead('nope')).toBeUndefined();
  });

  it('journals nothing for a rename to the same label', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const conversation = h.store.resolveOrCreateConversation(space, 'daily').id;
    h.store.renameAgent(agent, 'alice');
    h.store.renameConversation(conversation, 'daily');
    const rows = h.store.database.prepare('SELECT COUNT(*) AS n FROM label_history').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});

describe('an attachment fetch is a read', () => {
  it('writes a read-log row naming the file and its message', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const attachment = newAttachmentId();
    const posted = h.store.postMessage({
      sender: { kind: 'agent', id: agent },
      target: { space, title: 'notes' },
      body: 'see attached',
      attachments: [{ id: attachment, filename: 'a.csv', contentType: 'text/csv', sizeBytes: 3 }],
    });

    h.store.recordAttachmentRead(agent, attachment, posted.message.id);
    const entry = h.store.readReadLog({ agent }).entries[0];
    expect(entry?.kind).toBe('attachment');
    expect(entry?.params).toEqual({ attachment, message: posted.message.id });
    expect(entry?.itemCount).toBe(1);
    expect(entry?.cursor).toBe('');
    // A file returns no stream position, so the resume hint is untouched.
    expect(h.store.lastReadCursor(agent)).toBeUndefined();
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

    expect(h.store.verifyKey(issued.key)?.id).toBe(agent);
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
    expect(h.store.verifyKey(replacement.key)?.id).toBe(agent);
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
    expect(h.store.listEscalations({ state: 'pending' }).escalations).toHaveLength(1);

    h.advance(30);
    const failed = h.store.markEscalationNotification(escalation.id, 'failed', {
      error: 'connect ECONNREFUSED',
      nextAttemptAt: '2026-01-01T00:01:00.000Z' as Timestamp,
    });
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe('connect ECONNREFUSED');
    expect(h.store.listEscalations({ state: 'pending' }).escalations).toHaveLength(0);

    const sent = h.store.markEscalationNotification(escalation.id, 'sent');
    expect(sent.attempts).toBe(2);
    expect(sent.notificationState).toBe('sent');
  });

  it('acknowledges idempotently and counts what is still unacknowledged', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const conversation = h.store.resolveOrCreateConversation(space, 'notes').id;
    const raise = (n: number): string =>
      h.store.recordEscalation({
        agent,
        conversation,
        reason: `problem ${n}`,
        idempotencyKey: key(`ack-e${n}`),
      }).escalation.id;
    const [first, second] = [raise(1), raise(2)];

    // Everything starts unacknowledged: acknowledging is a separate axis from
    // delivery, so a never-delivered escalation still wants a human until one
    // settles it.
    expect(h.store.countUnacknowledgedEscalations()).toBe(2);
    const before = h.store.listEscalations().escalations;
    expect(before.every((e) => e.acknowledgedAt === null)).toBe(true);

    h.advance(30);
    const acked = h.store.acknowledgeEscalation(first ?? '');
    expect(acked?.acknowledgedAt).toBe(h.at());
    expect(h.store.countUnacknowledgedEscalations()).toBe(1);

    // A second ack is a no-op that still succeeds and keeps the first time.
    h.advance(30);
    const again = h.store.acknowledgeEscalation(first ?? '');
    expect(again?.acknowledgedAt).toBe(acked?.acknowledgedAt);
    expect(h.store.countUnacknowledgedEscalations()).toBe(1);

    h.store.acknowledgeEscalation(second ?? '');
    expect(h.store.countUnacknowledgedEscalations()).toBe(0);

    // An unknown id is a miss, not an error: the route turns it into a 404.
    expect(h.store.acknowledgeEscalation('esc_nope')).toBeUndefined();
  });

  it('pages newest first for the inbox and oldest first for the notifier, without a gap', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const conversation = h.store.resolveOrCreateConversation(space, 'notes').id;
    const raise = (n: number): string => {
      h.advance(1);
      return h.store.recordEscalation({
        agent,
        conversation,
        reason: `problem ${n}`,
        idempotencyKey: key(`e${n}`),
      }).escalation.id;
    };
    const ids = [raise(1), raise(2), raise(3)];

    const newest = h.store.listEscalations({ order: 'newest', limit: 2 });
    expect(newest.escalations.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    expect(newest.hasMore).toBe(true);
    const older = h.store.listEscalations({
      order: 'newest',
      limit: 2,
      after: newest.nextCursor ?? undefined,
    });
    expect(older.escalations.map((e) => e.id)).toEqual([ids[0]]);
    expect(older.hasMore).toBe(false);
    // An empty page keeps the position it was given.
    const end = h.store.listEscalations({ order: 'newest', after: older.nextCursor ?? undefined });
    expect(end.escalations).toHaveLength(0);
    expect(end.nextCursor).toBe(older.nextCursor);

    const oldest = h.store.listEscalations({ order: 'oldest', limit: 2 });
    expect(oldest.escalations.map((e) => e.id)).toEqual([ids[0], ids[1]]);
    expect(
      h.store.listEscalations({ order: 'oldest', after: oldest.nextCursor ?? undefined })
        .escalations,
    ).toHaveLength(1);

    expect(h.store.countUndeliveredEscalations()).toBe(3);
    h.store.markEscalationNotification(ids[1] ?? '', 'sent');
    expect(h.store.countUndeliveredEscalations()).toBe(2);

    // A cursor names its order; the other order refuses it rather than
    // walking the other way from the same boundary.
    expectStoreError(
      () => h.store.listEscalations({ order: 'oldest', after: newest.nextCursor ?? undefined }),
      'invalid_request',
    );
  });

  it('refuses a cursor it cannot read', () => {
    const h = harness();
    expectStoreError(
      () => h.store.listEscalations({ after: 'nope' as unknown as EscalationCursor }),
      'invalid_request',
    );
  });

  it('pages across rows raised in the same millisecond without repeating or skipping one', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const conversation = h.store.resolveOrCreateConversation(space, 'notes').id;
    // No clock advance: created_at ties, and the id has to break it the same
    // way on every page.
    const ids = [1, 2, 3, 4, 5].map(
      (n) =>
        h.store.recordEscalation({
          agent,
          conversation,
          reason: `p${n}`,
          idempotencyKey: key(`s${n}`),
        }).escalation.id,
    );
    const seen: string[] = [];
    let after: EscalationCursor | undefined;
    for (;;) {
      const page = h.store.listEscalations({ order: 'newest', limit: 2, after });
      seen.push(...page.escalations.map((e) => e.id));
      if (!page.hasMore) break;
      after = page.nextCursor ?? undefined;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(seen).toEqual(h.store.listEscalations({ order: 'newest' }).escalations.map((e) => e.id));
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

  it('revokes every session when the password changes, and none when it has not', () => {
    const h = harness();
    // The first sighting cannot tell an upgrade from an upgrade that also
    // rotated the password, so it revokes: nothing vouches for a session
    // minted before any fingerprint was recorded.
    const issued = h.store.createSession(3600);
    expect(h.store.syncPasswordFingerprint('scrypt$first')).toBe(1);
    expect(h.store.verifySession(issued.token)).toBeUndefined();

    // Settled at that hash: the next start revokes nothing.
    const settled = h.store.createSession(3600);
    expect(h.store.syncPasswordFingerprint('scrypt$first')).toBe(0);
    expect(h.store.verifySession(settled.token)?.id).toBe(settled.id);

    const other = h.store.createSession(3600);
    expect(h.store.syncPasswordFingerprint('scrypt$second')).toBe(2);
    expect(h.store.verifySession(issued.token)).toBeUndefined();
    expect(h.store.verifySession(other.token)).toBeUndefined();

    // Settled again at the new hash: the next start revokes nothing.
    const fresh = h.store.createSession(3600);
    expect(h.store.syncPasswordFingerprint('scrypt$second')).toBe(0);
    expect(h.store.verifySession(fresh.token)?.id).toBe(fresh.id);

    // A hash of the hash: the verifier itself is never in the table.
    const stored = h.store.database
      .prepare("SELECT value FROM meta WHERE key = 'password-fingerprint'")
      .get() as { value: string };
    expect(stored.value).not.toBe('scrypt$second');
  });

  it('logs nobody out on a first boot, which has nobody to log out', () => {
    const h = harness();
    expect(h.store.syncPasswordFingerprint('scrypt$first')).toBe(0);
    const issued = h.store.createSession(3600);
    expect(h.store.syncPasswordFingerprint('scrypt$first')).toBe(0);
    expect(h.store.verifySession(issued.token)?.id).toBe(issued.id);
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
});

describe('a query refuses what its type would have caught', () => {
  it('rejects an order it does not know rather than reading backwards', () => {
    const h = harness();
    const { agent, space } = scene(h);
    expectStoreError(
      () =>
        h.store.readSpace({ kind: 'agent', id: agent }, space, { order: 'sideways' as 'newest' }),
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

describe('runs of empty stream polls are compacted', () => {
  /** Drains the membership event, so every later poll is genuinely empty. */
  function settle(h: Harness, agent: AgentId): Cursor {
    const page = h.store.readStream(agent);
    h.advance(60);
    return page.nextCursor;
  }

  /**
   * A whole sweep, batch by batch, totalled the way the server totals it. The
   * store hands back one batch per call, so every assertion about a sweep goes
   * through here.
   */
  function sweep(
    store: Store,
    cutoff: Timestamp,
    batchSize?: number,
  ): { collapsed: number; removed: number } {
    let collapsed = 0;
    let removed = 0;
    let resume: CollapseResume | undefined;
    // A batch that neither advances nor finishes is a bug, not a long log.
    for (let guard = 0; guard < 100; guard += 1) {
      const batch = store.collapseEmptyStreamReads(cutoff, {
        ...(batchSize === undefined ? {} : { batchSize }),
        ...(resume === undefined ? {} : { resume }),
      });
      collapsed += batch.collapsed;
      removed += batch.removed;
      if (batch.done) return { collapsed, removed };
      resume = batch.resume;
    }
    throw new Error('the sweep never finished');
  }

  /** `count` polls a minute apart, each resuming where the last left off. */
  function poll(h: Harness, agent: AgentId, from: Cursor, count: number): Cursor {
    let cursor = from;
    for (let i = 0; i < count; i += 1) {
      cursor = h.store.readStream(agent, { from: { after: cursor } }).nextCursor;
      h.advance(60);
    }
    return cursor;
  }

  it('collapses an idle run into its last read, which says what it stands for', () => {
    const h = harness();
    const { agent } = scene(h);
    const start = settle(h, agent);
    const began = h.at();
    const cursor = poll(h, agent, start, 4);
    const ended = h.store.readReadLog({ agent }).entries[0]?.readAt;

    expect(sweep(h.store, h.at())).toEqual({ collapsed: 1, removed: 3 });

    const entries = h.store.readReadLog({ agent }).entries;
    expect(entries).toHaveLength(2);
    const survivor = entries[0];
    // The last read of the run, unchanged in everything it recorded itself.
    expect(survivor?.readAt).toBe(ended);
    expect(survivor?.cursor).toBe(cursor);
    expect(survivor?.itemCount).toBe(0);
    expect(survivor?.collapsedCount).toBe(4);
    expect(survivor?.firstReadAt).toBe(began);
    // The read that returned the membership event is not a candidate.
    expect(entries[1]?.itemCount).toBe(1);
    expect(entries[1]?.collapsedCount).toBe(1);
  });

  it('collapses a run whose cursor moved past traffic the agent cannot see', () => {
    const h = harness();
    const { agent } = scene(h);
    const bob = h.store.createAgent('bob').id;
    const elsewhere = h.store.createSpace('other').id;
    h.store.grantMembership(bob, elsewhere);
    let cursor = settle(h, agent);

    // Each poll returns nothing but a cursor past bob's message, so the runs
    // differ in their parameters. What makes them one run is that each
    // resumed exactly where the last left off.
    const cursors = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      post(h, bob, elsewhere, 'theirs', `${i}`);
      cursor = h.store.readStream(agent, { from: { after: cursor } }).nextCursor;
      cursors.add(cursor);
      h.advance(60);
    }
    expect(cursors.size).toBe(3);

    expect(sweep(h.store, h.at())).toEqual({ collapsed: 1, removed: 2 });
    const entries = h.store.readReadLog({ agent }).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.collapsedCount).toBe(3);
    expect(entries[0]?.cursor).toBe(cursor);
  });

  it('breaks a run at a read that returned something', () => {
    const h = harness();
    const { agent, space } = scene(h);
    let cursor = settle(h, agent);
    cursor = poll(h, agent, cursor, 2);
    post(h, agent, space, 'notes', 'something');
    const delivered = h.store.readStream(agent, { from: { after: cursor } });
    expect(delivered.items).toHaveLength(1);
    h.advance(60);
    poll(h, agent, delivered.nextCursor, 2);

    // Two runs, on either side of the read that was handed something — which
    // keeps its own row and stands for itself.
    expect(sweep(h.store, h.at())).toEqual({ collapsed: 2, removed: 2 });
    expect(
      h.store.readReadLog({ agent }).entries.map((e) => [e.itemCount, e.collapsedCount]),
    ).toEqual([
      [0, 2],
      [1, 1],
      [0, 2],
      [1, 1],
    ]);
  });

  it('treats a row whose parameters will not parse as a break, not a fault', () => {
    const h = harness();
    const { agent } = scene(h);
    poll(h, agent, settle(h, agent), 3);
    const middle = h.store.readReadLog({ agent }).entries[1]?.id ?? '';
    h.store.database
      .prepare("UPDATE read_log SET params_json = 'not json' WHERE id = @id")
      .run({ id: middle });

    // Neither its predecessor nor its successor can be shown to have resumed
    // from it, so the run is three runs of one. Counted over the table, since
    // the forensic view parses what the sweep declined to trust.
    expect(sweep(h.store, h.at())).toEqual({ collapsed: 0, removed: 0 });
    const rows = h.store.database.prepare('SELECT COUNT(*) AS n FROM read_log').get() as {
      n: number;
    };
    expect(rows.n).toBe(4);
  });

  it('walks more candidates than one batch holds, and rejoins across the seam', () => {
    const h = harness();
    const { agent } = scene(h);
    const bob = h.store.createAgent('bob').id;
    const space = h.store.createSpace('other').id;
    h.store.grantMembership(bob, space);
    // Two agents polling in step, so the batches interleave them and each run
    // is only a run because the sweep keeps the agents apart.
    let mine = settle(h, agent);
    let theirs = settle(h, bob);
    const began = h.at();
    for (let i = 0; i < 7; i += 1) {
      mine = h.store.readStream(agent, { from: { after: mine } }).nextCursor;
      theirs = h.store.readStream(bob, { from: { after: theirs } }).nextCursor;
      h.advance(60);
    }

    // Three batches of at most five candidates, two runs straddling every
    // seam: each agent still ends with one row standing for its whole stretch,
    // and the seams are in neither count.
    expect(sweep(h.store, h.at(), 5)).toEqual({ collapsed: 2, removed: 12 });
    for (const [who, cursor] of [
      [agent, mine],
      [bob, theirs],
    ] as const) {
      const entries = h.store.readReadLog({ agent: who }).entries;
      expect(entries).toHaveLength(2);
      expect(entries[0]?.collapsedCount).toBe(7);
      expect(entries[0]?.firstReadAt).toBe(began);
      expect(entries[0]?.cursor).toBe(cursor);
    }

    // Nothing left to do, and a batch size is not an excuse to do it twice.
    expect(sweep(h.store, h.at(), 5)).toEqual({ collapsed: 0, removed: 0 });
  });

  it('reports the same sweep whatever the batch size', () => {
    /** Two runs of seven, either side of a read that was handed something. */
    function scenario(): { h: Harness; agent: AgentId } {
      const h = harness();
      const { agent, space } = scene(h);
      let cursor = poll(h, agent, settle(h, agent), 7);
      post(h, agent, space, 'notes', 'something');
      cursor = h.store.readStream(agent, { from: { after: cursor } }).nextCursor;
      h.advance(60);
      poll(h, agent, cursor, 7);
      return { h, agent };
    }

    const shape = (of: { h: Harness; agent: AgentId }): unknown[] =>
      of.h.store
        .readReadLog({ agent: of.agent })
        .entries.map((e) => [e.kind, e.itemCount, e.collapsedCount]);

    const batched = scenario();
    const whole = scenario();
    // Every run straddles a seam at five, and none of them at the default.
    const split = sweep(batched.h.store, batched.h.at(), 5);
    expect(split).toEqual({ collapsed: 2, removed: 12 });
    // Where the batches fall is the sweep's business and nobody else's: the
    // two runs are two runs, not one per batch they happen to span.
    expect(split).toEqual(sweep(whole.h.store, whole.h.at()));
    expect(shape(batched)).toEqual(shape(whole));
    expect(shape(batched)).toEqual([
      ['stream', 0, 7],
      ['stream', 1, 1],
      ['stream', 0, 7],
      ['stream', 1, 1],
    ]);
  });

  it('refuses a batch size that would never finish', () => {
    const h = harness();
    expectStoreError(
      () => h.store.collapseEmptyStreamReads(h.at(), { batchSize: 0 }),
      'invalid_request',
    );
  });

  it('merges a later run into the row a previous sweep left', () => {
    const h = harness();
    const { agent } = scene(h);
    let cursor = settle(h, agent);
    const began = h.at();
    cursor = poll(h, agent, cursor, 3);
    expect(sweep(h.store, h.at()).removed).toBe(2);

    cursor = poll(h, agent, cursor, 3);
    // Converges: a second sweep leaves one row for the stretch, not one per
    // sweep, because an already-collapsed row is an ordinary candidate.
    expect(sweep(h.store, h.at())).toEqual({ collapsed: 1, removed: 3 });
    const entries = h.store.readReadLog({ agent }).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.collapsedCount).toBe(6);
    expect(entries[0]?.firstReadAt).toBe(began);
  });

  it('leaves rows younger than the cutoff, and every other kind, alone', () => {
    const h = harness();
    const { agent, space } = scene(h);
    let cursor = settle(h, agent);
    const cutoff = h.at();
    cursor = poll(h, agent, cursor, 3);
    h.store.readSpace({ kind: 'agent', id: agent }, space);
    h.store.readConversation(
      { kind: 'agent', id: agent },
      h.store.resolveOrCreateConversation(space, 'notes').id,
    );

    expect(sweep(h.store, cutoff)).toEqual({ collapsed: 0, removed: 0 });
    expect(h.store.readReadLog({ agent }).entries).toHaveLength(6);

    // The queries returned nothing either, and are still their own rows.
    expect(sweep(h.store, h.at()).removed).toBe(2);
    const kinds = h.store.readReadLog({ agent }).entries.map((e) => e.kind);
    expect(kinds).toEqual(['conversation', 'space', 'stream', 'stream']);
  });

  it('pages cleanly over a collapsed log', () => {
    const h = harness();
    const { agent, space } = scene(h);
    let cursor = settle(h, agent);
    cursor = poll(h, agent, cursor, 4);
    h.store.readSpace({ kind: 'agent', id: agent }, space);
    h.advance(60);
    poll(h, agent, cursor, 4);
    sweep(h.store, h.at());

    // A read of another kind keeps its own row and does not break the run: the
    // collapsed row's span simply brackets it.
    const entries = h.store.readReadLog({ agent }).entries;
    expect(entries.map((e) => [e.kind, e.collapsedCount])).toEqual([
      ['stream', 8],
      ['space', 1],
      ['stream', 1],
    ]);
    const all = entries.map((e) => e.id);
    const seen: string[] = [];
    let after: ReadLogCursor | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: ReturnType<Store['readReadLog']> = h.store.readReadLog({
        agent,
        limit: 2,
        ...(after === null ? {} : { after }),
      });
      seen.push(...page.entries.map((e) => e.id));
      after = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(all);
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

describe('search pages', () => {
  it('continues relevance order from a cursor without repeating or skipping a hit', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const ids = ['alpha', 'alpha beta', 'alpha alpha', 'beta alpha', 'alpha gamma'].map(
      (body, i) => {
        h.advance(1);
        return post(h, agent, space, `t${i}`, body).id;
      },
    );
    const first = h.store.searchMessages('alpha', { limit: 2 });
    expect(first.hits).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = h.store.searchMessages('alpha', {
      limit: 2,
      after: first.nextCursor ?? undefined,
    });
    const third = h.store.searchMessages('alpha', {
      limit: 2,
      after: second.nextCursor ?? undefined,
    });
    const seen = [...first.hits, ...second.hits, ...third.hits].map((hit) => hit.message.id);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(third.hasMore).toBe(false);
    // The whole list in one page is the pages concatenated: same order.
    expect(h.store.searchMessages('alpha').hits.map((hit) => hit.message.id)).toEqual(seen);
  });

  it('continues past hits of equal rank, which is the equality arm of the cursor', () => {
    const h = harness();
    const { agent, space } = scene(h);
    // Identical bodies score identically; only the seq tells them apart.
    const ids = [1, 2, 3].map((n) => post(h, agent, space, `t${n}`, 'alpha').id);
    const seen: string[] = [];
    let after: SearchCursor | undefined;
    for (;;) {
      const page = h.store.searchMessages('alpha', { limit: 1, after });
      seen.push(...page.hits.map((hit) => hit.message.id));
      if (!page.hasMore) break;
      after = page.nextCursor ?? undefined;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(seen).toEqual(h.store.searchMessages('alpha').hits.map((hit) => hit.message.id));
  });

  it('pages newest first on the sequence when asked', () => {
    const h = harness();
    const { agent, space } = scene(h);
    const ids = [1, 2, 3].map((n) => post(h, agent, space, `t${n}`, `alpha ${n}`).id);
    const first = h.store.searchMessages('alpha', { order: 'newest', limit: 2 });
    expect(first.hits.map((hit) => hit.message.id)).toEqual([ids[2], ids[1]]);
    const rest = h.store.searchMessages('alpha', {
      order: 'newest',
      limit: 2,
      after: first.nextCursor ?? undefined,
    });
    expect(rest.hits.map((hit) => hit.message.id)).toEqual([ids[0]]);
    expect(rest.hasMore).toBe(false);
    expectStoreError(
      () => h.store.searchMessages('alpha', { after: 'nope' as unknown as SearchCursor }),
      'invalid_request',
    );
    // A newest cursor carries no rank, so relevance order refuses it — rather
    // than comparing against rank 0, which no match ever exceeds.
    expectStoreError(
      () => h.store.searchMessages('alpha', { after: first.nextCursor ?? undefined }),
      'invalid_request',
    );
    const relevance = h.store.searchMessages('alpha', { limit: 1 });
    expectStoreError(
      () =>
        h.store.searchMessages('alpha', {
          order: 'newest',
          after: relevance.nextCursor ?? undefined,
        }),
      'invalid_request',
    );
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
    expect(h.store.searchMessages('"hello world"').hits).toHaveLength(1);
    expect(h.store.searchMessages('"world hello"').hits).toHaveLength(0);
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
    // Who opened each thread, as a current label: alice renamed reads as such.
    expect(alpha?.openedBy).toEqual({ kind: 'agent', id: agent, displayName: 'alice' });
    h.store.renameAgent(agent, 'alicia');
    expect(h.store.listConversationSummaries(space)[1]?.openedBy).toMatchObject({
      displayName: 'alicia',
    });
    expect(summaries[2]?.openedBy).toEqual({ kind: 'human', displayName: 'the human' });

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
