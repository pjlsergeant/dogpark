/**
 * The reader: a space's threads on the left, one thread's messages on the
 * right, and a composer under them.
 *
 * This is the screen the human actually lives in, so it is the one that has
 * to be pleasant: per-agent attribution, day separators, real timestamps on
 * hover, rendered markdown, attachments as downloads. Nothing agent-authored
 * is ever rendered as markup.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConversationId, MessageId, SpaceId } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { href, navigate } from '../app/router.js';
import { dayHeading, sameDay } from '../app/format.js';
import { Empty, Failure, Loading, Time } from '../components/bits.js';
import { MessageView } from '../components/MessageView.js';
import { Composer } from '../components/Composer.js';

const POLL_MS = 20_000;

export function ReaderScreen({
  space,
  conversation,
  message,
}: {
  space?: SpaceId | undefined;
  conversation?: ConversationId | undefined;
  message?: MessageId | undefined;
}): ReactNode {
  const api = useApi();
  const spaces = useAsync(() => api.listSpaces(), [api]);
  const [filter, setFilter] = useState('');

  if (space === undefined) {
    return (
      <section className="screen">
        <header className="screen-head">
          <h1>Reader</h1>
        </header>
        {spaces.state.error !== null && (
          <Failure error={spaces.state.error} onRetry={spaces.reload} />
        )}
        {spaces.state.data === null ? (
          <Loading what="spaces" />
        ) : (
          <ul className="cards">
            {spaces.state.data.map((each) => (
              <li key={each.id} className="card">
                <a className="card-title" href={href.read(each.id)}>
                  {each.name}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <SpaceReader
      key={space}
      space={space}
      conversation={conversation}
      message={message}
      filter={filter}
      onFilter={setFilter}
      spaceNames={(spaces.state.data ?? []).map((s) => [s.id, s.name] as const)}
    />
  );
}

function SpaceReader({
  space,
  conversation,
  message,
  filter,
  onFilter,
  spaceNames,
}: {
  space: SpaceId;
  conversation?: ConversationId | undefined;
  message?: MessageId | undefined;
  filter: string;
  onFilter: (value: string) => void;
  spaceNames: readonly (readonly [SpaceId, string])[];
}): ReactNode {
  const api = useApi();
  const conversations = useAsync(() => api.listConversations(space), [api, space]);
  const threads = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = conversations.state.data ?? [];
    return needle === '' ? all : all.filter((c) => c.title.toLowerCase().includes(needle));
  }, [conversations.state.data, filter]);

  return (
    <div className="reader">
      <aside className="reader-threads">
        <div className="reader-space-picker">
          <label className="visually-hidden" htmlFor="reader-space">
            Space
          </label>
          <select
            id="reader-space"
            value={space}
            onChange={(event) => navigate(href.read(event.target.value as SpaceId))}
          >
            {spaceNames.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <a className="btn btn-quiet" href={href.space(space)} title="Members and settings">
            Manage
          </a>
        </div>

        <input
          className="reader-filter"
          type="search"
          placeholder="Filter threads"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          aria-label="Filter threads"
        />

        <a
          className={`thread new-thread${conversation === undefined ? ' current' : ''}`}
          href={href.read(space)}
        >
          + New thread
        </a>

        {conversations.state.status === 'loading' && conversations.state.data === null && (
          <Loading what="threads" />
        )}
        {conversations.state.error !== null && (
          <Failure error={conversations.state.error} onRetry={conversations.reload} />
        )}
        <ul className="threads">
          {threads.map((thread) => (
            <li key={thread.id}>
              <a
                className={`thread${thread.id === conversation ? ' current' : ''}`}
                href={href.read(space, thread.id)}
              >
                <span className="thread-title">{thread.title}</span>
                <span className="thread-meta">
                  {thread.lastMessageAt === null ? (
                    'empty'
                  ) : (
                    <>
                      <Time iso={thread.lastMessageAt} />
                      {thread.lastSenderName !== null && ` - ${thread.lastSenderName}`}
                    </>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
        {conversations.state.data !== null && threads.length === 0 && (
          <Empty>No threads match.</Empty>
        )}
      </aside>

      <main className="reader-main">
        {conversation === undefined ? (
          <div className="reader-empty">
            <h2>Start a thread</h2>
            <p className="muted">
              A message goes to a subject line. If a thread with that exact title already exists in
              this space, this appends to it; otherwise it opens it.
            </p>
            <Composer
              space={space}
              onPosted={(opened) => {
                conversations.reload();
                navigate(href.read(space, opened));
              }}
            />
          </div>
        ) : (
          <Thread
            key={conversation}
            space={space}
            conversation={conversation}
            highlight={message}
            title={threads.find((t) => t.id === conversation)?.title ?? null}
            onPosted={() => conversations.reload()}
          />
        )}
      </main>
    </div>
  );
}

function Thread({
  space,
  conversation,
  highlight,
  title,
  onPosted,
}: {
  space: SpaceId;
  conversation: ConversationId;
  highlight?: MessageId | undefined;
  title: string | null;
  onPosted: () => void;
}): ReactNode {
  const api = useApi();
  const page = useAsync(() => api.readConversation(conversation), [api, conversation]);
  const reload = page.reload;
  const bottom = useRef<HTMLDivElement>(null);
  const messages = page.state.data?.messages ?? [];
  const count = messages.length;

  // Poll while the tab is in front. Agents post while nobody is looking.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (count === 0) return;
    if (highlight !== undefined) {
      const target = document.getElementById(`m-${highlight}`);
      if (target !== null) {
        target.scrollIntoView({ block: 'center' });
        return;
      }
    }
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count, highlight]);

  const heading = title ?? messages[0]?.conversationTitle ?? 'Conversation';

  return (
    <>
      <header className="thread-head">
        <h1>{heading}</h1>
        <button type="button" className="btn btn-quiet" onClick={page.reload}>
          Refresh
        </button>
      </header>

      <div className="thread-body">
        {page.state.status === 'loading' && page.state.data === null && <Loading what="messages" />}
        {page.state.error !== null && <Failure error={page.state.error} onRetry={page.reload} />}
        {page.state.data !== null && count === 0 && <Empty>Nothing here yet. Say something.</Empty>}
        {page.state.data?.hasMore === true && (
          <p className="muted small">
            Showing the most recent page. Older messages are still in this thread.
          </p>
        )}
        {messages.map((each, index) => {
          const previous = messages[index - 1];
          const newDay = previous === undefined || !sameDay(previous.sentAt, each.sentAt);
          return (
            <div key={each.id}>
              {newDay && <div className="day-separator">{dayHeading(each.sentAt)}</div>}
              <MessageView message={each} highlighted={each.id === highlight} />
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <Composer
        space={space}
        conversation={conversation}
        onPosted={() => {
          page.reload();
          onPosted();
        }}
      />
    </>
  );
}
