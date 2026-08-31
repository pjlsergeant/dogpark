import type { Store } from '../store/index.js';
import type { Timestamp } from '../types.js';
import type { EscalationQueue, PendingEscalation } from './webhook.js';

/**
 * The notifier wants four verbs over pending escalations; the store keeps them
 * as rows with their own retry state. This is the whole of the adapter.
 * `onChange` runs after each state flip — the escalations screen shows
 * delivery state, so the UI's change signal has to hear about it.
 */
export function escalationQueue(store: Store, onChange: () => void): EscalationQueue {
  return {
    listDue(now, limit) {
      const due = store.listEscalations({
        state: 'pending',
        dueAt: new Date(now).toISOString() as Timestamp,
        order: 'oldest',
        limit,
      }).escalations;
      return due.map((record): PendingEscalation => {
        const conversation = store.getConversation(record.conversation);
        const space = conversation === undefined ? undefined : store.getSpace(conversation.space);
        return {
          id: record.id,
          agentName: store.getAgent(record.agent)?.displayName ?? record.agent,
          spaceName: space?.name ?? 'an unknown space',
          conversationTitle: conversation?.title ?? 'an unknown conversation',
          reason: record.reason,
          raisedAt: record.createdAt,
          attempts: record.attempts,
        };
      });
    },
    markSent(id) {
      store.markEscalationNotification(id, 'sent');
      onChange();
    },
    markFailed(id, nextAttemptAt, error) {
      // Still pending: a failure that is going to be retried is not a failed
      // notification, and the store counts the attempt itself. The reason is
      // written every time, so during backoff the row shows the live cause.
      store.markEscalationNotification(id, 'pending', {
        nextAttemptAt: new Date(nextAttemptAt).toISOString() as Timestamp,
        error,
      });
      onChange();
    },
    markGivenUp(id, error) {
      // The notifier composes the terminal marker around the real cause; the
      // store just records it, so nothing is discarded on give-up.
      store.markEscalationNotification(id, 'failed', { error });
      onChange();
    },
  };
}
