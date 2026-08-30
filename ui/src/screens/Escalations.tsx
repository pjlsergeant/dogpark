/**
 * The escalation inbox.
 *
 * An escalation is recorded whether or not anyone was told, so the
 * notification state is shown as prominently as the reason: a failed webhook
 * is the case where this screen is the only thing standing between an agent
 * saying "something is wrong" and nobody hearing it.
 */
import type { ReactNode } from 'react';
import type { Escalation, NotificationState } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { href } from '../app/router.js';
import { absoluteTime } from '../app/format.js';
import { Empty, Failure, Loading, Pill, Time } from '../components/bits.js';
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

function Row({ escalation }: { escalation: Escalation }): ReactNode {
  return (
    <li className={`escalation escalation-${escalation.notificationState}`}>
      <div className="escalation-head">
        <div>
          <strong>{escalation.agent.displayName}</strong> <span className="muted">flagged</span>{' '}
          <a href={href.read(escalation.conversation.space, escalation.conversation.id)}>
            {escalation.conversation.title}
          </a>{' '}
          <span className="muted">in {escalation.spaceName}</span>
        </div>
        <div className="row">
          <Pill tone={TONE[escalation.notificationState]}>{escalation.notificationState}</Pill>
          <span className="muted" title={absoluteTime(escalation.createdAt)}>
            <Time iso={escalation.createdAt} />
          </span>
        </div>
      </div>

      {/* Agent-authored: rendered as a safe subset, never as markup. */}
      <blockquote className="escalation-reason">
        <InlineMarkdown source={escalation.reason} />
      </blockquote>

      <div className="escalation-notify muted small">
        {EXPLANATION[escalation.notificationState]}{' '}
        {escalation.attempts > 0 && (
          <>
            {escalation.attempts} attempt{escalation.attempts === 1 ? '' : 's'}
            {escalation.lastAttemptAt !== null && (
              <>
                , last <Time iso={escalation.lastAttemptAt} />
              </>
            )}
            {escalation.nextAttemptAt !== null && (
              <>
                , next <Time iso={escalation.nextAttemptAt} />
              </>
            )}
            .
          </>
        )}
        {escalation.lastError !== null && (
          <div className="escalation-error">
            <code>{escalation.lastError}</code>
          </div>
        )}
      </div>
    </li>
  );
}

export function EscalationsScreen(): ReactNode {
  const api = useApi();
  const escalations = useAsync(() => api.listEscalations(), [api]);
  const items = escalations.state.data?.items ?? [];
  const unhandled = items.filter((e) => e.notificationState !== 'sent').length;

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
          {unhandled > 0 && <Pill tone="warn">{unhandled} not delivered</Pill>}
          <button type="button" className="btn" onClick={escalations.reload}>
            Refresh
          </button>
        </div>
      </header>

      {escalations.state.error !== null && (
        <Failure error={escalations.state.error} onRetry={escalations.reload} />
      )}
      {escalations.state.status === 'loading' && escalations.state.data === null && (
        <Loading what="escalations" />
      )}
      {escalations.state.data !== null && items.length === 0 && (
        <Empty>Nothing has been escalated.</Empty>
      )}

      <ul className="escalations">
        {items.map((escalation) => (
          <Row key={escalation.id} escalation={escalation} />
        ))}
      </ul>
    </section>
  );
}
