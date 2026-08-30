/**
 * Escalation notification.
 *
 * An escalation is recorded first and notified second, so the API call means
 * "recorded" rather than "someone was told" (docs/architecture.md). This drains
 * the recorded ones, retrying with backoff, so a crash between recording and
 * sending loses nothing and a webhook outage delays rather than drops.
 */

export interface PendingEscalation {
  readonly id: string;
  readonly agentName: string;
  readonly spaceName: string;
  readonly conversationTitle: string;
  readonly reason: string;
  readonly raisedAt: string;
  /** How many sends have already been tried and failed. */
  readonly attempts: number;
}

/**
 * What the notifier needs from storage, and no more. `listDue` reads rather
 * than claims: one process and one drain at a time (`Notifier.drain`) is what
 * keeps two sends of one escalation apart.
 */
export interface EscalationQueue {
  listDue(now: number, limit: number): PendingEscalation[];
  markSent(id: string): void;
  markFailed(id: string, nextAttemptAt: number): void;
  markGivenUp(id: string): void;
}

export interface NotifierOptions {
  readonly webhookUrl?: string | undefined;
  /**
   * Abort a send that has not answered in this long.
   *
   * Without it a hung webhook holds the re-entrancy guard for the life of the
   * process, so every later escalation is silently never sent — a worse
   * outcome than the double-send the guard prevents, because nobody is paged
   * and nothing says so.
   */
  readonly timeoutMs?: number;
  /** Give up after this many failures; the escalation stays visible in the UI. */
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

const MINUTE = 60_000;

/** Exponential with a ceiling: 1m, 2m, 4m … capped at an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * MINUTE, 60 * MINUTE);
}

export function formatMessage(e: PendingEscalation): string {
  return [
    `*${e.agentName}* raised something in *${e.spaceName}*`,
    `> ${e.reason.replace(/\n/g, '\n> ')}`,
    `_${e.conversationTitle} — ${e.raisedAt}_`,
  ].join('\n');
}

export class Notifier {
  #queue: EscalationQueue;
  #url: string | undefined;
  #maxAttempts: number;
  #now: () => number;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #timer: NodeJS.Timeout | undefined;
  #draining = false;

  constructor(queue: EscalationQueue, options: NotifierOptions = {}) {
    this.#queue = queue;
    this.#url = options.webhookUrl;
    this.#maxAttempts = options.maxAttempts ?? 8;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Drain what is due, returning how many were sent. Without a webhook
   * configured this does nothing at all and escalations simply accumulate in
   * the UI, which is a legitimate deployment.
   */
  async drain(limit = 20): Promise<number> {
    if (!this.#url) return 0;

    // Two overlapping drains would send the same escalation twice — and the
    // point of an escalation is that it wakes someone. One process, so a
    // re-entrancy guard is enough; a second caller returns rather than
    // queueing behind the first.
    if (this.#draining) return 0;
    this.#draining = true;
    try {
      return await this.#drain(this.#url, limit);
    } finally {
      this.#draining = false;
    }
  }

  async #drain(url: string, limit: number): Promise<number> {
    const due = this.#queue.listDue(this.#now(), limit);
    let sent = 0;

    for (const e of due) {
      try {
        const res = await this.#fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: formatMessage(e) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
        this.#queue.markSent(e.id);
        sent++;
      } catch {
        const attempts = e.attempts + 1;
        if (attempts >= this.#maxAttempts) this.#queue.markGivenUp(e.id);
        else this.#queue.markFailed(e.id, this.#now() + backoffMs(attempts));
      }
    }
    return sent;
  }

  start(onError: (e: unknown) => void, intervalMs = 10_000): void {
    // Failures inside the queue — not the webhook, which drain() handles —
    // would otherwise escape as an unhandled rejection from a timer, which
    // can take the process down and otherwise makes notification stop
    // silently. Silent is the worst outcome for the thing that pages a human.
    this.#timer ??= setInterval(() => {
      this.drain().catch(onError);
    }, intervalMs).unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
