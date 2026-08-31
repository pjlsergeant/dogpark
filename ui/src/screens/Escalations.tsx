/**
 * The escalation inbox.
 *
 * An escalation is the product's page-a-human channel, so the headline is
 * whether anyone has *seen* it: the badge counts the unacknowledged, and each
 * one carries an acknowledge action. Delivery state — whether the webhook was
 * told — is a separate axis, demoted to per-row detail, and dropped entirely
 * when no webhook is configured, where it would only be noise.
 */
import { useCallback } from 'react';
import type { ReactNode } from 'react';
import type { Escalation, EscalationPage, NotificationState } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useOnChange } from '../app/changes.js';
import { useAsync } from '../app/useAsync.js';
import { usePages } from '../app/usePages.js';
import { href } from '../app/router.js';
import { Empty, Failure, Loading, Pill, Time } from '../components/bits.js';
import { LoadMore } from '../components/LoadMore.js';
import { useNotify } from '../components/Toasts.js';
import { InlineMarkdown } from '../markdown/Markdown.js';

const TONE: Record<NotificationState, string> = {
  pending: 'info',
  sent: 'ok',
  failed: 'bad',
};

const EXPLANATION: Record<NotificationState, string> = {
  pending: 'Recorded, and waiting to be delivered to the webhook.',
  sent: 'Delivered to the webhook.',
  failed: 'Delivery gave up after retrying. Nobody was told out of band.',
};

function Row({
  escalation,
  spaceName,
  webhookConfigured,
  onAcknowledge,
}: {
  escalation: Escalation;
  spaceName: string;
  webhookConfigured: boolean;
  onAcknowledge: (escalation: Escalation) => void;
}): ReactNode {
  const status = escalation.notification;
  const attempts = status.attempts;
  const acknowledgedAt = escalation.acknowledgedAt;
  return (
    <li
      className={`escalation escalation-${status.state}${acknowledgedAt !== null ? ' escalation-acknowledged' : ''}`}
    >
      <div className="escalation-head">
        <div>
          <strong>{escalation.agent.displayName}</strong> <span className="muted">flagged</span>{' '}
          <a href={href.read(escalation.conversation.space, escalation.conversation.id)}>
            {escalation.conversation.title}
          </a>{' '}
          <span className="muted">in {spaceName}</span>
        </div>
        <div className="row">
          {/* Delivery state is meaningless without a webhook, so it is shown
              only when one is configured. */}
          {webhookConfigured && <Pill tone={TONE[status.state]}>{status.state}</Pill>}
          <span className="muted">
            <Time iso={escalation.raisedAt} />
          </span>
        </div>
      </div>

      {/* Agent-authored: rendered as a safe subset, never as markup. */}
      <blockquote className="escalation-reason">
        <InlineMarkdown source={escalation.reason} />
      </blockquote>

      <div className="escalation-foot row">
        {acknowledgedAt !== null ? (
          <span className="muted small">
            Acknowledged <Time iso={acknowledgedAt} />
          </span>
        ) : (
          <button type="button" className="btn" onClick={() => onAcknowledge(escalation)}>
            Acknowledge
          </button>
        )}
      </div>

      {webhookConfigured && (
        <div className="escalation-notify muted small">
          {EXPLANATION[status.state]}{' '}
          {attempts > 0 && (
            <>
              {attempts} attempt{attempts === 1 ? '' : 's'}
              {status.lastAttemptAt !== null && (
                <>
                  , last <Time iso={status.lastAttemptAt} />
                </>
              )}
              {status.nextAttemptAt !== null && (
                <>
                  , next <Time iso={status.nextAttemptAt} />
                </>
              )}
              .
            </>
          )}
          {status.lastError !== null && (
            <div className="escalation-error">
              <code>{status.lastError}</code>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function EscalationsScreen(): ReactNode {
  const api = useApi();
  const notify = useNotify();
  const pages = usePages<Escalation, EscalationPage>(
    (after) => api.listEscalations(after === undefined ? undefined : { after }),
    [api],
  );
  const spaces = useAsync(() => api.listSpaces(), [api]);
  // A new escalation arrives at the top, so follow the change signal — but
  // not once older pages are loaded, where a refresh would throw them away
  // mid-read. Deep in the backlog, Refresh is the person's own gesture.
  useOnChange(() => {
    if (!pages.paged) pages.refresh();
  });
  // Counted server-side over every row, not over the page on screen.
  const unacknowledged = pages.first.data?.unacknowledged ?? 0;
  // Delivery state is meaningless without a webhook; the server says whether
  // there is one, and the whole delivery axis is dropped when there is not.
  const webhookConfigured = pages.first.data?.webhookConfigured ?? false;
  const nameOf = (id: string): string =>
    (spaces.state.data ?? []).find((s) => s.id === id)?.name ?? 'a space';

  const acknowledge = useCallback(
    (escalation: Escalation) => {
      void (async () => {
        try {
          await api.acknowledgeEscalation(escalation.id);
          notify('ok', 'Acknowledged.');
          // The ack signals, but this is the person's own gesture, so refresh
          // now rather than waiting for the poll to return.
          pages.refresh();
        } catch (cause) {
          notify('bad', cause instanceof Error ? cause.message : String(cause));
        }
      })();
    },
    [api, notify, pages],
  );

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h1>Escalations</h1>
          <p className="muted">
            A private channel to you: the agent an escalation is about never sees it.
          </p>
        </div>
        <div className="row">
          {unacknowledged > 0 && <Pill tone="warn">{unacknowledged} unacknowledged</Pill>}
          <button type="button" className="btn" onClick={pages.refresh}>
            Refresh
          </button>
        </div>
      </header>

      {pages.first.error !== null && <Failure error={pages.first.error} onRetry={pages.refresh} />}
      {pages.first.status === 'loading' && pages.first.data === null && (
        <Loading what="escalations" />
      )}
      {pages.first.data !== null && pages.items.length === 0 && (
        <Empty>Nothing has been escalated.</Empty>
      )}

      <ul className="escalations">
        {pages.items.map((escalation) => (
          <Row
            key={escalation.id}
            escalation={escalation}
            spaceName={nameOf(escalation.conversation.space)}
            webhookConfigured={webhookConfigured}
            onAcknowledge={acknowledge}
          />
        ))}
      </ul>

      <LoadMore pages={pages} label="Load older escalations" />
    </section>
  );
}
