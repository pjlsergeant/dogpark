/**
 * The escalation inbox.
 *
 * An escalation is recorded whether or not anyone was told, so the
 * notification state is shown as prominently as the reason: a failed webhook
 * is the case where this screen is the only thing standing between an agent
 * saying "something is wrong" and nobody hearing it.
 */
import type { ReactNode } from 'react';
import type { Escalation, EscalationPage, NotificationState } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { usePages } from '../app/usePages.js';
import { href } from '../app/router.js';
import { Empty, Failure, Loading, Pill, Time } from '../components/bits.js';
import { LoadMore } from '../components/LoadMore.js';
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

function Row({ escalation, spaceName }: { escalation: Escalation; spaceName: string }): ReactNode {
  const status = escalation.notification;
  const attempts = status.attempts;
  return (
    <li className={`escalation escalation-${status.state}`}>
      <div className="escalation-head">
        <div>
          <strong>{escalation.agent.displayName}</strong> <span className="muted">flagged</span>{' '}
          <a href={href.read(escalation.conversation.space, escalation.conversation.id)}>
            {escalation.conversation.title}
          </a>{' '}
          <span className="muted">in {spaceName}</span>
        </div>
        <div className="row">
          <Pill tone={TONE[status.state]}>{status.state}</Pill>
          <span className="muted">
            <Time iso={escalation.raisedAt} />
          </span>
        </div>
      </div>

      {/* Agent-authored: rendered as a safe subset, never as markup. */}
      <blockquote className="escalation-reason">
        <InlineMarkdown source={escalation.reason} />
      </blockquote>

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
    </li>
  );
}

export function EscalationsScreen(): ReactNode {
  const api = useApi();
  const pages = usePages<Escalation, EscalationPage>(
    (after) => api.listEscalations(after === undefined ? undefined : { after }),
    [api],
  );
  const spaces = useAsync(() => api.listSpaces(), [api]);
  // Counted server-side over every row, not over the page on screen.
  const undelivered = pages.first.data?.undelivered ?? 0;
  const nameOf = (id: string): string =>
    (spaces.state.data ?? []).find((s) => s.id === id)?.name ?? 'a space';

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h1>Escalations</h1>
          <p className="muted">
            Out of band by design: the agent that raised it does not know you were told, and the
            peer it is about never sees it.
          </p>
        </div>
        <div className="row">
          {undelivered > 0 && <Pill tone="warn">{undelivered} not delivered</Pill>}
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
          />
        ))}
      </ul>

      <LoadMore pages={pages} label="Load older escalations" />
    </section>
  );
}
