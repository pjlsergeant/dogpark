import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Crockford-style base32 without the letters that read as digits, so an id
 * copied out of a log by hand survives the trip.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 16 characters, 80 bits. */
export const ID_LENGTH = 16;

/**
 * The character class of an id, used by the mention tokeniser as well. Ids
 * never contain `_`, which is what lets `dgp_<agent-id>_<secret>` be split at
 * its first two underscores whatever the secret's alphabet.
 */
export const ID_PATTERN = `[0-9a-hjkmnp-tv-z]{${ID_LENGTH}}`;

export const KEY_PREFIX = 'dgp';

/**
 * `dgp_<agent-id>_<secret>`, split at the first two underscores: the prefix
 * and the id are both underscore-free, so everything after the second is the
 * secret, whatever characters it carries. A string in any other shape claims
 * nothing.
 */
export function splitKey(presented: string): { agent: string; secret: string } | undefined {
  const first = presented.indexOf('_');
  if (first < 0) return undefined;
  const second = presented.indexOf('_', first + 1);
  if (second < 0) return undefined;
  const prefix = presented.slice(0, first);
  const agent = presented.slice(first + 1, second);
  const secret = presented.slice(second + 1);
  if (prefix !== KEY_PREFIX || agent === '' || secret === '') return undefined;
  return { agent, secret };
}

export function newId(): string {
  const bytes = randomBytes(ID_LENGTH);
  let out = '';
  for (let i = 0; i < ID_LENGTH; i += 1) {
    // A byte modulo 32 is uniform: 256 is a multiple of 32, so there is no
    // modulo bias to reject samples for.
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

/** For secrets and their hashes: a length mismatch is the only early exit. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
