import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { escalationQueue } from './queue.js';
import type { Store } from '../store/index.js';
import { openStore } from '../store/index.js';
import type { IdempotencyKey } from '../types.js';

const key = (value: string): IdempotencyKey => value as IdempotencyKey;

describe('the escalation queue adapter', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const raised = (): { store: Store; id: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'dogpark-queue-'));
    dirs.push(dir);
    const store = openStore({ file: join(dir, 'dogpark.db'), humanDisplayName: 'the human' });
    stores.push(store);
    const agent = store.createAgent('worrier');
    const space = store.createSpace('quiet');
    store.grantMembership(agent.id, space.id);
    const posted = store.postMessage({
      sender: { kind: 'agent', id: agent.id },
      target: { space: space.id, title: 'odd' },
      body: 'something is off',
      idempotencyKey: key('q-post'),
    });
    const { escalation } = store.recordEscalation({
      agent: agent.id,
      conversation: posted.conversation.id,
      reason: 'this looks wrong',
      idempotencyKey: key('q-esc'),
    });
    return { store, id: escalation.id };
  };

  it('tells the change signal about every delivery-state flip', () => {
    // The escalations screen shows delivery state and follows the change
    // signal, so a flip that stayed silent would leave it saying "pending"
    // for an escalation that was delivered — or worse, one given up on.
    const { store, id } = raised();
    let changes = 0;
    const queue = escalationQueue(store, () => (changes += 1));

    const state = (): string => {
      const [only] = store.listEscalations().escalations;
      if (only === undefined) throw new Error('the escalation vanished');
      return only.notificationState;
    };

    queue.markFailed(id, Date.now() + 60_000);
    expect(changes).toBe(1);
    expect(state()).toBe('pending');

    queue.markSent(id);
    expect(changes).toBe(2);
    expect(state()).toBe('sent');

    queue.markGivenUp(id);
    expect(changes).toBe(3);
    expect(state()).toBe('failed');
  });

  it('lists what is due with the names the webhook message wants', () => {
    const { store, id } = raised();
    const queue = escalationQueue(store, () => {});
    const due = queue.listDue(Date.now() + 1000, 10);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      id,
      agentName: 'worrier',
      spaceName: 'quiet',
      conversationTitle: 'odd',
      reason: 'this looks wrong',
    });
  });
});
