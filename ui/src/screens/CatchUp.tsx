import type { ReactNode } from 'react';
import type { HumanCatchUpConversation, Page } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useOnChange } from '../app/changes.js';
import { useAsync } from '../app/useAsync.js';
import { usePages } from '../app/usePages.js';
import { href } from '../app/router.js';
import { Empty, Failure, Loading, Pill, Time } from '../components/bits.js';
import { LoadMore } from '../components/LoadMore.js';

export function CatchUpScreen(): ReactNode {
  const api = useApi();
  const pages = usePages<HumanCatchUpConversation, Page<HumanCatchUpConversation>>(
    async (after) => {
      const page = await api.listCatchUp(after);
      return { items: page.conversations, nextCursor: page.nextCursor, hasMore: page.hasMore };
    },
    [api],
  );
  const escalations = useAsync(() => api.listEscalations({ limit: 1 }), [api]);
  useOnChange(() => {
    if (!pages.paged) pages.refresh();
    escalations.reload();
  });
  const unacknowledged = escalations.state.data?.unacknowledged ?? 0;

  return (
    <section className="screen catch-up">
      <header className="screen-head">
        <div>
          <h1>Catch up</h1>
          <p className="muted">Unread activity across every space, newest first.</p>
        </div>
        <button type="button" className="btn" onClick={pages.refresh}>
          Refresh
        </button>
      </header>

      {unacknowledged > 0 && (
        <aside className="catch-up-escalations">
          <strong>
            {unacknowledged} unacknowledged escalation{unacknowledged === 1 ? '' : 's'}
          </strong>
          <a className="btn" href={href.escalations()}>
            Review escalations
          </a>
        </aside>
      )}

      {pages.first.error !== null && <Failure error={pages.first.error} onRetry={pages.refresh} />}
      {pages.first.status === 'loading' && pages.first.data === null && (
        <Loading what="unread conversations" />
      )}
      {pages.first.data !== null && pages.items.length === 0 && <Empty>You're caught up.</Empty>}

      <ul className="catch-up-rows">
        {pages.items.map((row) => (
          <li key={row.id} className="catch-up-row">
            <div className="catch-up-row-main">
              <span className="muted small">{row.space.name}</span>
              <a
                className="card-title"
                href={href.readCatchUp(row.space.id, row.id, row.unreadCount)}
              >
                {row.title}
              </a>
              <span className="muted small">
                {row.lastSender.displayName} · <Time iso={row.latestActivityAt} />
              </span>
            </div>
            <div className="row">
              {row.hasPins && <span title="Pinned messages">📌</span>}
              {row.status === 'complete' ? (
                <Pill tone="neutral">complete, {row.unreadCount} new</Pill>
              ) : (
                <Pill tone="info">{row.unreadCount} new</Pill>
              )}
            </div>
          </li>
        ))}
      </ul>
      <LoadMore pages={pages} label="Load more conversations" />
    </section>
  );
}
