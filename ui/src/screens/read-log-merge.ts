/**
 * Fold a freshly fetched newest page into the rows already shown.
 *
 * The read log is newest-first and append-only, so anything new sits at the
 * front. A row already held is dropped, which keeps the order stable and the
 * React keys steady — no flicker, no reshuffle. Nothing is ever removed here:
 * the poll only ever adds.
 *
 * If the fetched page and what is held share no row, more than a page has
 * arrived since the last look and a plain prepend would leave a hole in the
 * middle; the held list is returned untouched and that gap is left to a
 * Refresh, which is honest about replacing everything. This mirrors the
 * Reader's tip poll.
 */
import type { ReadLogEntry } from '../api/index.js';

export function mergeReads(
  existing: readonly ReadLogEntry[],
  fetched: readonly ReadLogEntry[],
): readonly ReadLogEntry[] {
  if (existing.length === 0) return fetched;
  const held = new Set(existing.map((entry) => entry.id));
  const fresh = fetched.filter((entry) => !held.has(entry.id));
  if (fresh.length === 0) return existing;
  // Shared nothing: a gap the poll cannot bridge without a hole.
  if (fresh.length === fetched.length) return existing;
  return [...fresh, ...existing];
}
