/** The foot of a paged list: one button, and a word if the last try failed. */
import type { ReactNode } from 'react';
import type { Pages } from '../app/usePages.js';
import type { Page } from '../api/index.js';

export function LoadMore<T, P extends Page<T>>({
  pages,
  label,
}: {
  pages: Pages<T, P>;
  label: string;
}): ReactNode {
  if (!pages.hasMore) return null;
  return (
    <div className="row load-more">
      <button type="button" className="btn" disabled={pages.busy} onClick={pages.loadMore}>
        {pages.busy ? 'Loading…' : label}
      </button>
      {pages.moreFailed && <span className="muted small">That did not load. Try again.</span>}
    </div>
  );
}
