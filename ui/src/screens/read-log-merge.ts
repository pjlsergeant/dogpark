/**
 * Fold a freshly fetched newest page into the rows already shown.
 *
 * The read log is newest-first and append-only at the head, so anything new
 * sits at the front and a row already held keeps its place — order stays
 * stable and the React keys steady, no flicker, no reshuffle.
 *
 * Held rows are not immutable, though: a compaction sweep MUTATES a retained
 * row (its `collapsedCount` and `firstReadAt` move as it swallows a run of
 * empty polls) and deletes the siblings it absorbed. So a re-fetched row wins —
 * it replaces the copy held under the same id, fresh data over stale. The
 * deleted siblings are the one thing this cannot fix: they linger on screen
 * until a Refresh, which is honest about replacing everything.
 *
 * The result says which of three things happened, because reference equality
 * alone cannot tell them apart:
 *   - `unchanged`: the page brought no new row and changed no held one.
 *   - `gap`: the page and the held list share no row, so more than a page has
 *     arrived since the last look and a plain prepend would leave a hole in the
 *     middle. The caller decides whether to refresh or leave it (ReadLog.tsx).
 *   - `merged`: fresh rows to prepend and/or held rows to replace, in `rows`.
 * This mirrors the Reader's tip poll.
 */
import type { ReadLogEntry } from '../api/index.js';

export type MergeReads =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'gap' }
  | { readonly kind: 'merged'; readonly rows: readonly ReadLogEntry[] };

/** The only fields a held row can change under: what a compaction sweep moves. */
function compacted(a: ReadLogEntry, b: ReadLogEntry): boolean {
  return a.collapsedCount !== b.collapsedCount || a.firstReadAt !== b.firstReadAt;
}

export function mergeReads(
  existing: readonly ReadLogEntry[],
  fetched: readonly ReadLogEntry[],
): MergeReads {
  if (existing.length === 0) {
    return fetched.length === 0 ? { kind: 'unchanged' } : { kind: 'merged', rows: fetched };
  }
  const held = new Set(existing.map((entry) => entry.id));
  // Genuinely new rows can only be a contiguous prefix of the newest-first
  // page: everything the poll has not seen, then the overlap with what it has.
  // An unheld id AFTER a held one is not news — a compaction sweep deleted
  // held rows and older ones slid up onto the page — and prepending it would
  // present an older row as the tip. That, like sharing nothing at all, is a
  // gap the caller settles with a refresh.
  let prefix = 0;
  while (prefix < fetched.length && !held.has(fetched[prefix]?.id ?? '')) prefix += 1;
  if (fetched.slice(prefix).some((entry) => !held.has(entry.id))) return { kind: 'gap' };
  const fresh = fetched.slice(0, prefix);
  if (fresh.length > 0 && fresh.length === fetched.length) return { kind: 'gap' };

  // A re-fetched row replaces the held one where a compaction has moved it on.
  const byId = new Map(fetched.map((entry) => [entry.id, entry]));
  let changed = fresh.length > 0;
  const rebuilt = existing.map((entry) => {
    const latest = byId.get(entry.id);
    if (latest !== undefined && compacted(latest, entry)) {
      changed = true;
      return latest;
    }
    return entry;
  });
  if (!changed) return { kind: 'unchanged' };
  return { kind: 'merged', rows: [...fresh, ...rebuilt] };
}
