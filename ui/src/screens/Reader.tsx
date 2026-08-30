/**
 * The reader: a space's threads on the left, one thread's messages on the
 * right, and a composer under them.
 *
 * This is the screen the human actually lives in, so it is the one that has
 * to be pleasant: per-agent attribution, day separators, real timestamps on
 * hover, rendered markdown, attachments as downloads. Nothing agent-authored
 * is ever rendered as markup.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError, ConversationId, Message, MessageId, SpaceId } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { toApiError, useAsync } from '../app/useAsync.js';
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
                  {thread.lastActivityAt === null || thread.lastActivityAt === undefined ? (
                    ''
                  ) : (
                    <>
                      <Time iso={thread.lastActivityAt} />
                      {thread.lastSender?.displayName !== null &&
                        thread.lastSender?.displayName !== undefined &&
                        ` - ${thread.lastSender?.displayName}`}
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

/**
 * One thread.
 *
 * Paging is the awkward part, and the shape of the awkwardness is the API's:
 * `GET /conversations/:id/messages` takes `since`, `until` and `after`, and
 * `after` walks *forwards* from the start of the range. There is no "the last
 * N messages", so a reader that always started at the beginning would make
 * the human page through a year to reach today.
 *
 * So the reader opens on a time window and widens on request, which `since`
 * expresses exactly. A window with nothing in it widens itself once, because
 * that is what anyone would do next.
 */
type Window = '14d' | '90d' | 'all';

const WINDOWS: readonly {
  readonly id: Window;
  readonly label: string;
  readonly days: number | null;
}[] = [
  { id: '14d', label: 'Last 14 days', days: 14 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: 'all', label: 'Everything', days: null },
];

function sinceFor(window: Window): string | undefined {
  const days = WINDOWS.find((w) => w.id === window)?.days ?? null;
  return days === null ? undefined : new Date(Date.now() - days * 86_400_000).toISOString();
}

interface Loaded {
  readonly messages: readonly Message[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** How many pages have been pulled, so polling knows whether it can reset. */
  readonly pages: number;
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
  const [window_, setWindow] = useState<Window>('14d');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [widened, setWidened] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (choice: Window) => {
      setBusy(true);
      setError(null);
      try {
        const since = sinceFor(choice);
        const page = await api.readConversation(conversation, since === undefined ? {} : { since });
        setLoaded({
          messages: page.messages,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          pages: 1,
        });
      } catch (cause) {
        setError(toApiError(cause));
      } finally {
        setBusy(false);
      }
    },
    [api, conversation],
  );

  const loadMore = useCallback(async () => {
    if (loaded === null || loaded.nextCursor === null) return;
    setBusy(true);
    try {
      const page = await api.readConversation(conversation, { after: loaded.nextCursor });
      setLoaded((current) =>
        current === null
          ? current
          : {
              messages: [...current.messages, ...page.messages],
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              pages: current.pages + 1,
            },
      );
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setBusy(false);
    }
  }, [api, conversation, loaded]);

  useEffect(() => {
    void load(window_);
  }, [load, window_]);

  // An empty window is almost always the wrong window. Widen once, say so.
  useEffect(() => {
    if (widened || window_ !== '14d') return;
    if (loaded !== null && loaded.messages.length === 0 && !loaded.hasMore) {
      setWidened(true);
      setWindow('all');
    }
  }, [loaded, widened, window_]);

  // Poll while the tab is in front, but only when the view is one page and
  // caught up: re-reading would otherwise throw away pages already pulled.
  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setLoaded((current) => {
        if (current !== null && current.pages === 1 && !current.hasMore) void load(window_);
        return current;
      });
    }, POLL_MS);
    return () => globalThis.clearInterval(timer);
  }, [load, window_]);

  const messages = loaded?.messages ?? [];
  const count = messages.length;
  const onFirstPage = loaded?.pages === 1;

  useEffect(() => {
    if (count === 0) return;
    if (highlight !== undefined) {
      const target = document.getElementById(`m-${highlight}`);
      if (target !== null) {
        target.scrollIntoView({ block: 'center' });
        return;
      }
    }
    if (onFirstPage) bottom.current?.scrollIntoView({ block: 'end' });
  }, [count, highlight, onFirstPage]);

  const heading = title ?? messages[0]?.conversationTitle ?? 'Conversation';

  return (
    <>
      <header className="thread-head">
        <h1>{heading}</h1>
        <div className="row">
          <label className="visually-hidden" htmlFor="thread-window">
            How far back
          </label>
          <select
            id="thread-window"
            value={window_}
            onChange={(event) => {
              setWidened(true);
              setWindow(event.target.value as Window);
            }}
          >
            {WINDOWS.map((each) => (
              <option key={each.id} value={each.id}>
                {each.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-quiet" onClick={() => void load(window_)}>
            Refresh
          </button>
        </div>
      </header>

      <div className="thread-body">
        {busy && loaded === null && <Loading what="messages" />}
        {error !== null && <Failure error={error} onRetry={() => void load(window_)} />}
        {loaded !== null && count === 0 && (
          <Empty>Nothing in this window. Widen it, or say something.</Empty>
        )}
        {widened && window_ === 'all' && count > 0 && (
          <p className="muted small">Nothing in the last 14 days, so this is the whole thread.</p>
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

        {loaded?.hasMore === true && (
          <div className="load-more">
            <button type="button" className="btn" onClick={() => void loadMore()} disabled={busy}>
              {busy ? 'Loading...' : 'Load newer messages'}
            </button>
            <span className="muted small">
              This conversation pages forwards from the start of the window.
            </span>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <Composer
        space={space}
        conversation={conversation}
        onPosted={() => {
          void load(window_);
          onPosted();
        }}
      />
    </>
  );
}
