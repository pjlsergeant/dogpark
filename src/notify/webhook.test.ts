import { describe, expect, it, vi } from 'vitest';
import {
  backoffMs,
  formatMessage,
  Notifier,
  type EscalationQueue,
  type PendingEscalation,
} from './webhook.js';

const escalation = (over: Partial<PendingEscalation> = {}): PendingEscalation => ({
  id: 'esc_1',
  agentName: 'accounting',
  spaceName: 'money-and-life',
  conversationTitle: '2027 budget',
  reason: 'numbers look wrong',
  raisedAt: '2026-08-30T10:00:00Z',
  attempts: 0,
  ...over,
});

function fakeQueue(pending: PendingEscalation[]) {
  const calls = {
    sent: [] as string[],
    failed: [] as [string, number, number][],
    gaveUp: [] as string[],
  };
  const queue: EscalationQueue = {
    claimDue: () => pending,
    markSent: (id) => calls.sent.push(id),
    markFailed: (id, a, n) => calls.failed.push([id, a, n]),
    markGivenUp: (id) => calls.gaveUp.push(id),
  };
  return { queue, calls };
}

describe('Notifier', () => {
  it('sends what is due and marks it sent', async () => {
    const { queue, calls } = fakeQueue([escalation()]);
    const fetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const sent = await new Notifier(queue, { webhookUrl: 'https://hook', fetch }).drain();
    expect(sent).toBe(1);
    expect(calls.sent).toEqual(['esc_1']);
  });

  it('retries with backoff rather than dropping, when the webhook fails', async () => {
    const { queue, calls } = fakeQueue([escalation({ attempts: 2 })]);
    const fetch = vi.fn(async () => new Response('nope', { status: 500 }));
    await new Notifier(queue, { webhookUrl: 'https://hook', fetch, now: () => 1000 }).drain();
    expect(calls.sent).toEqual([]);
    expect(calls.failed).toEqual([['esc_1', 3, 1000 + backoffMs(3)]]);
  });

  it('gives up eventually, leaving the escalation visible rather than retrying forever', async () => {
    const { queue, calls } = fakeQueue([escalation({ attempts: 7 })]);
    const fetch = vi.fn(async () => {
      throw new Error('unreachable');
    });
    await new Notifier(queue, { webhookUrl: 'https://hook', fetch, maxAttempts: 8 }).drain();
    expect(calls.gaveUp).toEqual(['esc_1']);
  });

  it('does nothing without a webhook: escalations still accumulate in the UI', async () => {
    const { queue, calls } = fakeQueue([escalation()]);
    const fetch = vi.fn();
    expect(await new Notifier(queue, { fetch: fetch as never }).drain()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.sent).toEqual([]);
  });

  it('caps backoff so a long outage does not become an infinite wait', () => {
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });

  it('quotes the reason so a multi-line escalation stays readable', () => {
    expect(formatMessage(escalation({ reason: 'one\ntwo' }))).toContain('> one\n> two');
  });
});
