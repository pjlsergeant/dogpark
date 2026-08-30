/**
 * Full text over message bodies (FTS5), with every result linking into the
 * reader at the message it found.
 *
 * One thing worth knowing while using it: mentions are stored as reference
 * tokens, not names, so searching for an agent's *name* will not find the
 * mentions of it. That is the trade that makes a rename touch no index, and
 * the screen says so rather than leaving it to be discovered.
 */
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { SearchResult, SpaceId } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { href, navigate } from '../app/router.js';
import { absoluteTime } from '../app/format.js';
import { Empty, Failure, Loading, Time } from '../components/bits.js';

function excerpt(result: SearchResult): string {
  if (result.snippet !== null && result.snippet !== undefined && result.snippet !== '') {
    return result.snippet;
  }
  const body = result.message.body.replace(/\s+/g, ' ').trim();
  return body.length > 240 ? `${body.slice(0, 240)}...` : body;
}

export function SearchScreen({ q, space }: { q: string; space?: SpaceId | undefined }): ReactNode {
  const api = useApi();
  const [draft, setDraft] = useState(q);
  const spaces = useAsync(() => api.listSpaces(), [api]);
  const results = useAsync(
    () => (q.trim() === '' ? Promise.resolve(null) : api.search({ q, space })),
    [api, q, space],
  );

  useEffect(() => setDraft(q), [q]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    navigate(href.search(draft, space));
  }

  const items = results.state.data?.items ?? [];

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
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {results.state.error !== null && (
        <Failure error={results.state.error} onRetry={results.reload} />
      )}
      {q.trim() === '' && <Empty>Type something to search for.</Empty>}
      {q.trim() !== '' && results.state.status === 'loading' && results.state.data === null && (
        <Loading what="results" />
      )}
      {q.trim() !== '' && results.state.data !== null && items.length === 0 && (
        <Empty>Nothing matched.</Empty>
      )}

      <ul className="results">
        {items.map((result) => (
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
                <span title={absoluteTime(result.message.sentAt)}>
                  <Time iso={result.message.sentAt} />
                </span>
              </span>
              {/* Plain text: a search snippet is agent-authored and is not markup. */}
              <span className="result-excerpt">{excerpt(result)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
