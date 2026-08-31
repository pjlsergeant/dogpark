/** Full text over stored bodies; every result links into the reader at its message. */
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Page, SearchOrder, SearchResult, SpaceId } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useOnChange } from '../app/changes.js';
import { useAsync } from '../app/useAsync.js';
import { usePages } from '../app/usePages.js';
import { href, navigate } from '../app/router.js';
import { Empty, Failure, Loading, Time } from '../components/bits.js';
import { LoadMore } from '../components/LoadMore.js';

const NONE: Page<SearchResult> = { items: [], nextCursor: null, hasMore: false };

function excerpt(result: SearchResult): string {
  if (result.snippet !== '') return result.snippet;
  const body = result.message.body.replace(/\s+/g, ' ').trim();
  return body.length > 240 ? `${body.slice(0, 240)}...` : body;
}

export function SearchScreen({
  q,
  space,
  order,
}: {
  q: string;
  space?: SpaceId | undefined;
  order?: SearchOrder | undefined;
}): ReactNode {
  const api = useApi();
  const [draft, setDraft] = useState(q);
  const spaces = useAsync(() => api.listSpaces(), [api]);
  const pages = usePages<SearchResult, Page<SearchResult>>(
    (after) => (q.trim() === '' ? Promise.resolve(NONE) : api.search({ q, space, order, after })),
    [api, q, space, order],
  );

  useEffect(() => setDraft(q), [q]);

  // A new message can change what this query matches, and a post signals. Re-run
  // the query in place — never the draft, so a search half-typed is left alone —
  // and only while one is actually running. A results list walked past its first
  // page holds off, the same rule usePages keeps for the Reader's poll.
  useOnChange(() => {
    if (q.trim() !== '' && !pages.paged) pages.refresh();
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    navigate(href.search(draft, space, order));
  }

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h1>Search</h1>
          <p className="muted">
            Full text over stored message bodies. Mentions are stored as tokens rather than names,
            so searching a name will not turn up mentions of it.
          </p>
        </div>
      </header>

      <form className="search-form" onSubmit={submit}>
        <input
          id="search-input"
          type="search"
          value={draft}
          placeholder="Words in a message"
          onChange={(event) => setDraft(event.target.value)}
          autoFocus
          aria-label="Search"
        />
        <label className="visually-hidden" htmlFor="search-space">
          Limit to a space
        </label>
        <select
          id="search-space"
          value={space ?? ''}
          onChange={(event) =>
            navigate(
              href.search(
                draft,
                event.target.value === '' ? undefined : (event.target.value as SpaceId),
                order,
              ),
            )
          }
        >
          <option value="">Every space</option>
          {(spaces.state.data ?? []).map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor="search-order">
          Order
        </label>
        <select
          id="search-order"
          value={order ?? 'relevance'}
          onChange={(event) =>
            navigate(
              href.search(draft, space, event.target.value === 'newest' ? 'newest' : undefined),
            )
          }
        >
          <option value="relevance">Most relevant</option>
          <option value="newest">Newest first</option>
        </select>
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {pages.first.error !== null && <Failure error={pages.first.error} onRetry={pages.refresh} />}
      {q.trim() === '' && <Empty>Type something to search for.</Empty>}
      {q.trim() !== '' && pages.first.status === 'loading' && pages.first.data === null && (
        <Loading what="results" />
      )}
      {q.trim() !== '' && pages.first.data !== null && pages.items.length === 0 && (
        <Empty>Nothing matched.</Empty>
      )}

      <ul className="results">
        {pages.items.map((result) => (
          <li key={result.message.id} className="result">
            <a
              className="result-link"
              href={href.read(result.message.space, result.message.conversation, result.message.id)}
            >
              <span className="result-title">
                {result.conversation.title || result.message.conversationTitle}
              </span>
              <span className="result-meta">
                {result.space.name} - {result.message.sender.displayName} -{' '}
                <Time iso={result.message.sentAt} />
              </span>
              {/* Plain text: a search snippet is agent-authored and is not markup. */}
              <span className="result-excerpt">{excerpt(result)}</span>
            </a>
          </li>
        ))}
      </ul>

      <LoadMore pages={pages} label="More results" />
    </section>
  );
}
