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
import type { ApiError, ConversationId, MessageId, SpaceId } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { toApiError, useAsync } from '../app/useAsync.js';
import { href, navigate } from '../app/router.js';
import { dayHeading, sameDay } from '../app/format.js';
import { Empty, Failure, Loading, Time } from '../components/bits.js';
import { MessageView } from '../components/MessageView.js';
import { Composer } from '../components/Composer.js';
import { NameDialog } from '../components/NameDialog.js';
import { loadThread, olderPage } from './thread-pages.js';
import type { Loaded } from './thread-pages.js';

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
 * One thread, newest page first — or, arriving by a link to one message,
 * every page back to that message (`thread-pages.ts`).
 */
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
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [renaming, setRenaming] = useState(false);
  /**
   * Every full reload gets a number. A read that was already out when one
   * happened lands into a thread that no longer exists as it knew it, so it
   * discards itself rather than prepending a page relative to a first page
   * that has been replaced.
   */
  const generation = useRef(0);
  /** A full reload is out, so the poll has nothing useful to add yet. */
  const reloading = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  /**
   * The message a link asked for, sought once: the next full load walks back
   * to it and scrolls there, and every load after that — Refresh, a post, a
   * new link to the same thread aside — opens at the live edge like any
   * other. `?m=` stays in the URL, so it is consumed here rather than read.
   */
  const seek = useRef<MessageId | undefined>(undefined);
  /** Counts full loads, so the scroll effect can tell one from an append. */
  const [arrivals, setArrivals] = useState(0);

  const load = useCallback(async () => {
    const mine = (generation.current += 1);
    reloading.current = true;
    setBusy(true);
    setError(null);
    try {
      const thread = await loadThread(api, conversation, seek.current);
      if (mine !== generation.current) return;
      setLoaded(thread);
      setArrivals((n) => n + 1);
    } catch (cause) {
      if (mine === generation.current) setError(toApiError(cause));
    } finally {
      if (mine === generation.current) {
        reloading.current = false;
        setBusy(false);
      }
    }
  }, [api, conversation]);

  const loadOlder = useCallback(async () => {
    if (loaded === null || loaded.nextCursor === null) return;
    const mine = generation.current;
    setBusy(true);
    try {
      const older = await olderPage(api, conversation, loaded);
      if (mine !== generation.current) return;
      // Merged against what is held now, not the snapshot the page was asked
      // for: a poll may have appended to the end meanwhile, and those stay.
      setLoaded((current) =>
        current === null
          ? current
          : {
              messages: [
                ...older.messages.slice(0, older.messages.length - loaded.messages.length),
                ...current.messages,
              ],
              nextCursor: older.nextCursor,
              hasMore: older.hasMore,
              pages: current.pages + 1,
            },
      );
    } catch (cause) {
      if (mine === generation.current) setError(toApiError(cause));
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  }, [api, conversation, loaded]);

  /**
   * What has arrived since the last look, added to the end.
   *
   * Deliberately not a reload. Replacing state with the newest page slides the
   * window on a thread longer than one page — the oldest message on screen
   * vanishes — and throws away any older pages already pulled. Appending does
   * neither, so a long thread live-updates like a short one.
   *
   * If the newest page and what is held share nothing, more than a page has
   * arrived and appending would leave a hole in the middle. That is left for a
   * Refresh, which is honest about replacing everything.
   */
  const pollNewest = useCallback(async () => {
    const mine = generation.current;
    try {
      const page = await api.readConversation(conversation, { order: 'newest' });
      if (mine !== generation.current) return;
      const newest = [...page.messages].reverse();
      setLoaded((current) => {
        if (current === null) return current;
        const held = new Set(current.messages.map((m) => m.id));
        const added = newest.filter((m) => !held.has(m.id));
        if (added.length === 0 || added.length === newest.length) return current;
        return { ...current, messages: [...current.messages, ...added] };
      });
    } catch {
      // A poll that fails is a poll that fails; the next one will try again.
    }
  }, [api, conversation]);

  useEffect(() => {
    seek.current = highlight;
    void load();
  }, [load, highlight]);

  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState !== 'visible' || reloading.current) return;
      void pollNewest();
    }, POLL_MS);
    return () => globalThis.clearInterval(timer);
  }, [pollNewest]);

  const messages = loaded?.messages ?? [];
  const count = messages.length;
  const onFirstPage = loaded?.pages === 1;
  // The newest message's id, not the count: a full page replaced by a full
  // page — the human posting into a thread longer than one page — changes
  // what is newest without changing how many are shown.
  const newestId = messages.at(-1)?.id;
  const seen = useRef(0);

  useEffect(() => {
    if (newestId === undefined) return;
    const fresh = arrivals !== seen.current;
    seen.current = arrivals;
    if (fresh) {
      // A full load: land on the message that was sought, if the walk found
      // it; otherwise — no link, a stale id, a thread longer than the budget
      // — at the live edge, however many pages were pulled on the way.
      const sought = seek.current;
      seek.current = undefined;
      const target = sought === undefined ? null : document.getElementById(`m-${sought}`);
      if (target !== null) target.scrollIntoView({ block: 'center' });
      else bottom.current?.scrollIntoView({ block: 'end' });
      return;
    }
    // A new tip while only the newest page is shown: follow it. On a thread
    // that has been walked back, the human is reading history and stays put.
    if (onFirstPage) bottom.current?.scrollIntoView({ block: 'end' });
  }, [arrivals, newestId, onFirstPage]);

  const heading = title ?? messages[0]?.conversationTitle ?? 'Conversation';

  return (
    <>
      <header className="thread-head">
        <h1>{heading}</h1>
        <div className="row">
          <button type="button" className="btn btn-quiet" onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </header>

      {renaming && (
        <NameDialog
          title={`Rename "${heading}"`}
          label="Title"
          initial={heading}
          submitLabel="Rename"
          hint="The title is how agents address this thread, so a rename changes where their next message lands."
          onClose={() => setRenaming(false)}
          onSubmit={async (next) => {
            await api.renameConversation(conversation, next);
            setRenaming(false);
            onPosted();
          }}
        />
      )}

      <div className="thread-body">
        {busy && loaded === null && <Loading what="messages" />}
        {error !== null && <Failure error={error} onRetry={() => void load()} />}
        {loaded !== null && count === 0 && <Empty>Nothing here yet. Say something.</Empty>}

        {loaded?.hasMore === true && (
          <div className="load-more">
            <button type="button" className="btn" onClick={() => void loadOlder()} disabled={busy}>
              {busy ? 'Loading...' : 'Load older messages'}
            </button>
          </div>
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
          void load();
          onPosted();
        }}
      />
    </>
  );
}
