import type { AgentId, Timestamp } from '../types.js';
import { invalid, StoreError } from './errors.js';
import { ID_PATTERN } from './ids.js';

/**
 * The reserved control character (ADR-0010): U+001E, INFORMATION SEPARATOR
 * TWO. Reported to agents by `identity()`.
 */
export const RESERVED_SEQUENCE = '';

/**
 * Rejected, never stripped. Stripping one occurrence from a doubled sequence
 * produces a valid one, which is the classic bypass; a comparison cannot be
 * subtly wrong. Applies to every piece of supplied text — bodies, titles,
 * filenames, escalation reasons, names — including the human's, since human
 * text also reaches a flattened conversation.
 */
export function assertNoReservedSequence(field: string, value: string): void {
  if (value.includes(RESERVED_SEQUENCE)) {
    throw new StoreError(
      'reserved_sequence',
      `${field} contains the reserved sequence U+001E; escape it and retry`,
    );
  }
}

/**
 * Names have no spaces, so `@name` needs no delimiters to parse (ADR-0014).
 * The class is also what bounds a mention, so widening it widens the parser.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertValidName(field: string, value: string): void {
  assertNoReservedSequence(field, value);
  if (!NAME_RE.test(value)) {
    throw invalid(
      `${field} must be 1-64 characters of letters, digits, dot, dash or underscore, ` +
        `starting with a letter or digit`,
    );
  }
}

export function assertNonEmpty(field: string, value: string): void {
  assertNoReservedSequence(field, value);
  if (value.trim().length === 0) throw invalid(`${field} must not be empty`);
}

/**
 * Timestamps are compared as text in SQL, so every one that reaches the
 * database — stored or supplied as a range bound — goes through here first. A
 * caller's `2026-08-30T10:35:00Z` would otherwise sort *after* a stored
 * `2026-08-30T10:35:00.000Z`, quietly making an inclusive `since` exclusive.
 */
export function normalizeTimestamp(field: string, value: string): Timestamp {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw invalid(`${field} is not a valid ISO-8601 timestamp`);
  return new Date(ms).toISOString() as Timestamp;
}

// A mention is bounded on the left so an email address is not one, and on the
// right by the name class itself. Both directions use the same boundaries, so
// what the encoder produces is exactly what the renderer finds.
const MENTION_RE = /(?<![A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;
const REFERENCE_RE = new RegExp(`(?<![A-Za-z0-9._-])@(${ID_PATTERN})(?![0-9a-hjkmnp-tv-z])`, 'g');

/** The stored form of a mention. Tokenised by FTS5 as the bare id. */
export function referenceToken(agent: AgentId): string {
  return `@${agent}`;
}

/**
 * Resolves `@name` to `@<agent-id>` at write time, so the stored body is a
 * canonical form rather than literal input (ADR-0014).
 *
 * `resolve` sees only agents the writer's space can see. An unresolvable name
 * stays literal and is **not** an error: a mention that failed differently
 * would reveal whether a stranger exists.
 */
export function encodeMentions(
  body: string,
  resolve: (name: string) => AgentId | undefined,
): string {
  return body.replace(MENTION_RE, (whole, name: string) => {
    // `@alice.` and `@alice,` are ordinary prose. Try the longest match first,
    // then shed trailing punctuation, so a name adjacent to a full stop still
    // resolves and the punctuation survives.
    let candidate = name;
    while (candidate.length > 0) {
      const agent = resolve(candidate);
      if (agent !== undefined) {
        return `${referenceToken(agent)}${name.slice(candidate.length)}`;
      }
      if (!/[._-]$/.test(candidate)) break;
      candidate = candidate.slice(0, -1);
    }
    return whole;
  });
}

/**
 * Renders a stored body back to current names. `resolve` returns undefined for
 * anything that is not an agent this reader's message may name, and the token
 * is then left exactly as stored — it was literal text that happened to look
 * like a reference.
 */
export function renderMentions(
  body: string,
  resolve: (agent: AgentId) => string | undefined,
): string {
  return body.replace(REFERENCE_RE, (whole, id: string) => {
    const name = resolve(id as AgentId);
    return name === undefined ? whole : `@${name}`;
  });
}

/**
 * The mentions of a stored body, in order of appearance and deduplicated.
 * Parsed on output: there is no mentions table, so a rename touches nothing.
 */
export function parseMentions(
  body: string,
  exists: (agent: AgentId) => boolean,
): readonly AgentId[] {
  const seen = new Set<AgentId>();
  for (const match of body.matchAll(REFERENCE_RE)) {
    const id = match[1] as AgentId | undefined;
    if (id !== undefined && !seen.has(id) && exists(id)) seen.add(id);
  }
  return [...seen];
}
