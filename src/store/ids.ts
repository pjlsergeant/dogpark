import { randomBytes } from 'node:crypto';

/**
 * Crockford-style base32 without the letters that read as digits, so an id
 * copied out of a log by hand survives the trip.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 16 characters, 80 bits. */
export const ID_LENGTH = 16;

/**
 * The character class of an id, used by the mention tokeniser as well. Ids
 * never contain `_`, which is what lets `dgp_<agent-id>_<secret>` be split on
 * the first and last underscore.
 */
export const ID_PATTERN = `[0-9a-hjkmnp-tv-z]{${ID_LENGTH}}`;

const ID_RE = new RegExp(`^${ID_PATTERN}$`);

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

export function isId(value: string): boolean {
  return ID_RE.test(value);
}
