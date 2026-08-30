import { createHash } from 'node:crypto';
import type { Conversation, Message } from '../types.js';
import { invalid } from './errors.js';

/**
 * Idempotency for the human's posts.
 *
 * The store scopes idempotency keys per agent and refuses one from the human,
 * which leaves the composer's double-click unprotected — the UI mints a key
 * per submission expecting it to mean something. So it is honoured here, in
 * memory: enough to collapse a double-click or a retried request, and honest
 * about being nothing more. Durable de-duplication is the store's, and the
 * store has declined it.
 */
export interface HumanPostRecord {
  readonly message: Message;
  readonly conversation: Conversation;
}

export interface HumanIdempotency {
  /** The earlier result for this key, or undefined if it is new. */
  lookup(key: string, request: unknown): HumanPostRecord | undefined;
  remember(key: string, request: unknown, result: HumanPostRecord): void;
}

interface Entry {
  readonly hash: string;
  readonly result: HumanPostRecord;
  readonly at: number;
}

const MAX_ENTRIES = 1_000;
const TTL_MS = 60 * 60_000;

export function createHumanIdempotency(now: () => number = Date.now): HumanIdempotency {
  const entries = new Map<string, Entry>();

  const hashOf = (request: unknown): string =>
    createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex');

  return {
    lookup(key, request) {
      const found = entries.get(key);
      if (found === undefined) return undefined;
      if (now() - found.at > TTL_MS) {
        entries.delete(key);
        return undefined;
      }
      // Same rule as the store's: a different request under the same key is an
      // error, not a silent replay of the old answer.
      if (found.hash !== hashOf(request)) {
        throw invalid('idempotency key was already used for a different request');
      }
      return found.result;
    },

    remember(key, request, result) {
      // Insertion-ordered: the oldest key is the first the map yields.
      if (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
      entries.set(key, { hash: hashOf(request), result, at: now() });
    },
  };
}
