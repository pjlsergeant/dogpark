/**
 * The reader: a space's threads on the left, one thread's messages on the
 * right, and a composer under them — or, as of a past read, the thread as
 * the agent could have seen it then, with nothing to post with.
 *
 * This is the screen the human actually lives in, so it is the one that has
 * to be pleasant: per-agent attribution, day separators, real timestamps on
 * hover, rendered markdown, attachments as downloads. Nothing agent-authored
 * is ever rendered as markup.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ApiError,
  ConversationAnnotations,
  ConversationId,
  ConversationSummary,
  MessageId,
  SpaceId,
} from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useOnChange } from '../app/changes.js';
import { toApiError, useAsync } from '../app/useAsync.js';
import { href, navigate } from '../app/router.js';
import { absoluteTime, dayHeading, sameDay } from '../app/format.js';
import { Empty, Failure, Loading, Pill, Time } from '../components/bits.js';
import { MessageView } from '../components/MessageView.js';
import { Composer } from '../components/Composer.js';
import { NameDialog } from '../components/NameDialog.js';
import { loadThread, olderPage } from './thread-pages.js';
import { loadFirstUnread } from './thread-pages.js';
import { ExportMenu } from '../components/ExportMenu.js';
import type { Loaded } from './thread-pages.js';

/**
 * A backstop only. New messages arrive through the app's long poll
 * (`app/changes.tsx`) the moment they are written; this catches one that the
 * poll missed — a reload that was in flight when the change came, say.
 */
const POLL_MS = 60_000;

export function ReaderScreen({
  space,
  conversation,
  message,
  asOf,
  unreadCount,
}: {
  space?: SpaceId | undefined;
  conversation?: ConversationId | undefined;
  message?: MessageId | undefined;
  asOf?: string | undefined;
  unreadCount?: number | undefined;
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
                <a className="card-title" href={href.read(each.id, undefined, undefined, asOf)}>
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
      asOf={asOf}
      unreadCount={unreadCount}
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
  asOf,
  filter,
  onFilter,
  spaceNames,
  unreadCount,
}: {
  space: SpaceId;
  conversation?: ConversationId | undefined;
  message?: MessageId | undefined;
  asOf?: string | undefined;
  filter: string;
  onFilter: (value: string) => void;
  spaceNames: readonly (readonly [SpaceId, string])[];
  unreadCount?: number | undefined;
}): ReactNode {
  const api = useApi();
  const conversations = useAsync(() => api.listConversations(space), [api, space]);
  // A new thread, or a last-activity that moved: the list follows the writes.
  useOnChange(conversations.reload);
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
            onChange={(event) =>
              navigate(href.read(event.target.value as SpaceId, undefined, undefined, asOf))
            }
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

        {asOf === undefined && (
          <a
            className={`thread new-thread${conversation === undefined ? ' current' : ''}`}
            href={href.read(space)}
          >
            + New thread
          </a>
        )}

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
                href={href.read(space, thread.id, undefined, asOf)}
              >
                <span className="thread-title">{thread.title}</span>
                <span className="thread-annotations">
                  {thread.annotations.status === 'complete' && <Pill tone="neutral">complete</Pill>}
                  {thread.annotations.pins.length > 0 && (
                    <span title="Pinned messages">📌 {thread.annotations.pins.length}</span>
                  )}
                </span>
                <span className="thread-meta">
                  {thread.lastActivityAt !== null && (
                    <>
                      <Time iso={thread.lastActivityAt} />
                      {thread.lastSender !== null && ` - ${thread.lastSender.displayName}`}
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
        {conversation === undefined && asOf !== undefined ? (
          <div className="reader-empty">
            <h2>As it was read</h2>
            <p className="muted">Pick a thread to see it as the agent saw it at that read.</p>
          </div>
        ) : conversation === undefined ? (
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
            // asOf is part of the key: live and as-of are different views of
            // the same thread, and a remount is what keeps one view's loaded
            // messages from flashing (or sticking, on a failed load) under the
            // other's banner.
            key={`${conversation}:${asOf ?? ''}`}
            space={space}
            conversation={conversation}
            highlight={message}
            asOf={asOf}
            unreadCount={unreadCount}
            summary={threads.find((t) => t.id === conversation) ?? null}
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
  asOf,
  summary,
  onPosted,
  unreadCount,
}: {
  space: SpaceId;
  conversation: ConversationId;
  highlight?: MessageId | undefined;
  /**
   * A read-log row id. The thread is then shown as it read at that row —
   * labels as of then, a banner saying so, and nothing to post with: the
   * past is not somewhere to say things.
   */
  asOf?: string | undefined;
  /** The thread list's row for this thread, once the list has loaded. */
  summary: ConversationSummary | null;
  onPosted: () => void;
  unreadCount?: number | undefined;
}): ReactNode {
  const api = useApi();
  const asOfRead = useAsync(
    () => (asOf === undefined ? Promise.resolve(null) : api.getRead(asOf)),
    [api, asOf],
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [annotations, setAnnotations] = useState(
    summary?.annotations ?? { status: 'open' as const, pins: [] },
  );
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
  const [unreadTarget, setUnreadTarget] = useState<MessageId | undefined>(undefined);
  /**
   * Annotations arrive from three places — a full load, the newest-page poll,
   * and an action's own response — and nothing orders their arrival. An
   * action's response is the newest truth the moment it lands, so it bumps
   * this epoch; a load or poll that began under an older epoch applies its
   * annotations to nothing. Polls also carry a serial, so two polls that both
   * began under the current epoch cannot land in the wrong order.
   */
  const annotationEpoch = useRef(0);
  const pollSerial = useRef(0);
  const pollApplied = useRef(0);
  /**
   * Actions would race each other too: Pin A then Pin B, and nothing says the
   * server handles them in that order or answers in it. Picking an answer by
   * client intent cannot fix that — the server may have finished on A. So
   * actions run one at a time, in the order they were made: the second is
   * sent only when the first has answered, every answer is the server's state
   * after that action, and the last answer is its last word. The composer's
   * posts (which may complete or pin) and its inline Reopen join the queue.
   * A failed action does not block the ones behind it.
   */
  const actionQueue = useRef<Promise<unknown>>(Promise.resolve());
  const runAction = <T,>(action: () => Promise<T>): Promise<T> => {
    const run = actionQueue.current.then(action, action);
    actionQueue.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const acceptFromAction = (next: ConversationAnnotations): void => {
    annotationEpoch.current += 1;
    setAnnotations(next);
  };
  const marked = useRef<MessageId | undefined>(undefined);

  const load = useCallback(async () => {
    const mine = (generation.current += 1);
    const epoch = annotationEpoch.current;
    reloading.current = true;
    setBusy(true);
    setError(null);
    try {
      const result =
        seek.current === undefined && unreadCount !== undefined
          ? await loadFirstUnread(api, conversation, unreadCount, asOf)
          : { loaded: await loadThread(api, conversation, seek.current, asOf), target: undefined };
      const thread = result.loaded;
      if (mine !== generation.current) return;
      if (result.target !== undefined) {
        seek.current = result.target;
        setUnreadTarget(result.target);
      }
      setLoaded(thread);
      if (thread.annotations !== undefined && epoch === annotationEpoch.current) {
        setAnnotations(thread.annotations);
      }
      setArrivals((n) => n + 1);
    } catch (cause) {
      if (mine === generation.current) setError(toApiError(cause));
    } finally {
      if (mine === generation.current) {
        reloading.current = false;
        setBusy(false);
      }
    }
  }, [api, conversation, asOf, unreadCount]);

  const loadOlder = useCallback(async () => {
    if (loaded === null || loaded.nextCursor === null) return;
    const mine = generation.current;
    setBusy(true);
    try {
      const older = await olderPage(api, conversation, loaded, asOf);
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
  }, [api, conversation, loaded, asOf]);

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
    const epoch = annotationEpoch.current;
    const serial = (pollSerial.current += 1);
    try {
      const page = await api.readConversation(conversation, { order: 'newest' });
      if (mine !== generation.current) return;
      const newest = [...page.messages].reverse();
      if (
        page.annotations !== undefined &&
        epoch === annotationEpoch.current &&
        serial > pollApplied.current
      ) {
        pollApplied.current = serial;
        setAnnotations(page.annotations);
      }
      setLoaded((current) => {
        if (current === null) return current;
        const held = new Set(current.messages.map((m) => m.id));
        const added = newest.filter((m) => !held.has(m.id));
        if (added.length === 0) return current;
        // No overlap means more than a page arrived and appending would leave
        // a hole — unless nothing was held, in which case the newest page is
        // simply the thread's first page, paging metadata included: what lies
        // behind it is reachable the ordinary way.
        if (held.size === 0) {
          return {
            ...current,
            messages: newest,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
          };
        }
        if (added.length === newest.length) return current;
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

  // Something was written somewhere: look at the tip now rather than at the
  // next tick. It may have been another thread — then nothing is added.
  useOnChange(() => {
    if (asOf === undefined && !reloading.current) void pollNewest();
  });

  useEffect(() => {
    // A thread as of a past read does not move.
    if (asOf !== undefined) return undefined;
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState !== 'visible' || reloading.current) return;
      void pollNewest();
    }, POLL_MS);
    return () => globalThis.clearInterval(timer);
  }, [pollNewest, asOf]);

  /**
   * As of a past read, the messages call can 404 for a thread the agent could
   * not see then (the membership check refuses it) — or for a read or thread
   * that no longer exists. The server deliberately does not distinguish the
   * two, so the "as X could have seen it" banner is reframed and the pane says
   * so honestly. A refusal also shows NO thread state: `loaded` can still hold
   * another view of this conversation (today's messages after "Back to now",
   * then the browser's Back restoring `?asOf=`), and rendering it under the
   * refusal copy would present exactly the messages the refusal says cannot
   * be shown.
   */
  const asOfRefused = asOf !== undefined && error !== null && error.code === 'not_found';
  const shown = asOfRefused ? null : loaded;
  const messages = shown?.messages ?? [];
  const count = messages.length;
  const onFirstPage = shown?.pages === 1;
  // The newest message's id, not the count: a full page replaced by a full
  // page — the human posting into a thread longer than one page — changes
  // what is newest without changing how many are shown.
  const newestId = messages.at(-1)?.id;
  const highlighted = highlight ?? unreadTarget;
  const seen = useRef(0);

  useEffect(() => {
    if (newestId === undefined) return;
    const fresh = arrivals !== seen.current;
    seen.current = arrivals;
    if (fresh) {
      // A full load: land on the message that was sought, if the walk found
      // it; otherwise — no link, a stale id, a thread longer than the budget
      // — at the live edge, on the newest page alone (`loadThread`).
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

  // The human's mark follows the newest message on screen — every thread
  // view, however it was reached, and never the as-of view, which shows what
  // an agent saw rather than what the human is reading now. Once per newest
  // id, so a re-render marks nothing twice; a failure is shown, and the next
  // full load — Refresh, or Retry on the failure itself — asks again, since
  // a thread whose mark never moved would sit in catch-up as unread.
  useEffect(() => {
    if (asOf !== undefined || newestId === undefined || marked.current === newestId) return;
    marked.current = newestId;
    void api.advanceReadMark(conversation, newestId).catch((cause: unknown) => {
      marked.current = undefined;
      setError(toApiError(cause));
    });
  }, [api, asOf, conversation, newestId, arrivals]);

  // As of a read, the rendered messages carry the title as it stood then;
  // the thread list is today's, so it is only a fallback while nothing has
  // loaded.
  const heading =
    (asOf === undefined
      ? (summary?.title ?? messages[0]?.conversationTitle)
      : (messages[0]?.conversationTitle ?? summary?.title)) ?? 'Conversation';
  const pinned = useMemo(() => {
    const byMessage = new Map<string, (typeof annotations.pins)[number]['actor'][]>();
    for (const pin of annotations.pins)
      byMessage.set(pin.message, [...(byMessage.get(pin.message) ?? []), pin.actor]);
    return byMessage;
  }, [annotations]);
  const humanPin = annotations.pins.find((pin) => pin.actor.kind === 'human')?.message;
  const updateAnnotations = async (action: () => Promise<ConversationAnnotations>) => {
    try {
      acceptFromAction(await runAction(action));
      onPosted();
    } catch (cause) {
      setError(toApiError(cause));
    }
  };

  return (
    <>
      <header className="thread-head">
        <div>
          <h1>{heading}</h1>
          {annotations.status === 'complete' && <Pill tone="neutral">complete</Pill>}
          {summary !== null && asOf === undefined && (
            <p className="muted small">
              opened by{' '}
              {summary.openedBy.kind === 'agent' ? (
                <a href={href.agents(summary.openedBy.id)}>{summary.openedBy.displayName}</a>
              ) : (
                'you'
              )}
            </p>
          )}
        </div>
        <div className="row">
          {asOf === undefined && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void updateAnnotations(() =>
                    annotations.status === 'complete'
                      ? api.reopenConversation(conversation)
                      : api.completeConversation(conversation),
                  )
                }
              >
                {annotations.status === 'complete' ? 'Reopen' : 'Complete'}
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setRenaming(true)}>
                Rename
              </button>
              <ExportMenu kind="conversation" id={conversation} />
            </>
          )}
          <button type="button" className="btn btn-quiet" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </header>

      {asOf !== undefined && (
        <p className="as-of" role="status">
          {asOfRead.state.error !== null ? (
            <>
              No such read ({asOfRead.state.error.message}).{' '}
              <a href={href.read(space, conversation)}>Back to now</a>
            </>
          ) : asOfRead.state.data === null || asOfRead.state.data === undefined ? (
            'As it was read — loading which read…'
          ) : asOfRefused ? (
            <>
              As read by <strong>{asOfRead.state.data.agent.displayName}</strong> at{' '}
              <time dateTime={asOfRead.state.data.at}>{absoluteTime(asOfRead.state.data.at)}</time>{' '}
              — but this thread cannot be shown as it was.{' '}
              <a href={href.read(space, conversation)}>Back to now</a>
            </>
          ) : (
            <>
              As <strong>{asOfRead.state.data.agent.displayName}</strong> could have seen it at{' '}
              <time dateTime={asOfRead.state.data.at}>{absoluteTime(asOfRead.state.data.at)}</time>:
              messages up to that moment, names and titles as they stood then — save your own
              display name, the one label not journaled, which shows as it is now. The thread list
              beside it is today's. <a href={href.read(space, conversation)}>Back to now</a>
            </>
          )}
        </p>
      )}

      {renaming && (
        <NameDialog
          title={`Rename "${heading}"`}
          label="Title"
          initial={heading}
          submitLabel="Rename"
          hint={`Agents address this thread by its title, so this changes where their next message lands. Anything still posting to "${heading}" will open a fresh thread by that old name rather than reach this one — how a memoryless agent's diary forks in two.`}
          onClose={() => setRenaming(false)}
          onSubmit={async (next) => {
            await api.renameConversation(conversation, next);
            setRenaming(false);
            onPosted();
          }}
        />
      )}

      <div className="thread-body">
        {pinned.size > 0 && (
          <nav className="pinned-summary" aria-label="Pinned messages">
            <strong>Pinned</strong>
            {[...pinned.entries()].map(([id, actors]) => {
              // A pin can point past the loaded pages; then the link says who
              // pinned rather than what, and scrolling to it loads nothing.
              const body = messages
                .find((m) => m.id === id)
                ?.body.replace(/\s+/g, ' ')
                .trim();
              const who = actors
                .map((actor) => (actor.kind === 'human' ? 'you' : actor.displayName))
                .join(', ');
              return (
                <a key={id} href={`#m-${id}`} title={`pinned by ${who}`}>
                  {body === undefined
                    ? `pinned by ${who}`
                    : body.length > 80
                      ? `${body.slice(0, 80)}…`
                      : body}
                  <span className="muted small"> — {who}</span>
                </a>
              );
            })}
          </nav>
        )}
        {busy && loaded === null && <Loading what="messages" />}
        {asOfRefused ? (
          <Empty>
            Nothing here to reconstruct. Either{' '}
            <strong>{asOfRead.state.data?.agent.displayName ?? 'this agent'}</strong> could not see
            this thread at that read, or the read or conversation no longer exists — the record does
            not distinguish the two.
          </Empty>
        ) : (
          error !== null && <Failure error={error} onRetry={() => void load()} />
        )}
        {shown !== null && count === 0 && (
          <Empty>
            {asOf === undefined
              ? 'Nothing here yet. Say something.'
              : 'Nothing had been posted yet.'}
          </Empty>
        )}

        {shown?.hasMore === true && (
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
              <MessageView
                message={each}
                highlighted={each.id === highlighted}
                pinnedBy={pinned.get(each.id) ?? []}
                humanPinned={humanPin === each.id}
                onPin={
                  asOf === undefined
                    ? () =>
                        void updateAnnotations(() =>
                          humanPin === each.id
                            ? api.unpinConversation(conversation)
                            : api.pinMessage(conversation, each.id),
                        )
                    : undefined
                }
              />
            </div>
          );
        })}

        <div ref={bottom} />
      </div>

      {asOf === undefined && (
        <Composer
          space={space}
          conversation={conversation}
          onPosted={() => {
            void load();
            onPosted();
          }}
          runAnnotationAction={runAction}
          onAnnotations={acceptFromAction}
        />
      )}
    </>
  );
}
