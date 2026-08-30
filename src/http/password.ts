import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * The human's password, verified against `DOGPARK_PASSWORD_HASH`.
 *
 * The design says "a password hash from the environment" and stops there, so
 * the encoding is chosen here: scrypt, because Node has it in core and adding
 * a native argon2 dependency to a container that already builds better-sqlite3
 * buys little.
 *
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<derived key base64url>
 *
 * Mint one with `node dist/server.js hash-password <password>`.
 */
const SCHEME = 'scrypt';
const N = 16_384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES, { N, r: R, p: P });
  return [SCHEME, N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface Parsed {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(stored: string): Parsed | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6) return undefined;
  const [scheme, n, r, p, salt, key] = parts;
  if (scheme !== SCHEME || n === undefined || r === undefined || p === undefined) return undefined;
  if (salt === undefined || key === undefined) return undefined;
  const numbers = [Number(n), Number(r), Number(p)];
  if (numbers.some((value) => !Number.isInteger(value) || value <= 0)) return undefined;
  const saltBytes = Buffer.from(salt, 'base64url');
  const keyBytes = Buffer.from(key, 'base64url');
  if (saltBytes.length === 0 || keyBytes.length === 0) return undefined;
  return {
    n: numbers[0] ?? 0,
    r: numbers[1] ?? 0,
    p: numbers[2] ?? 0,
    salt: saltBytes,
    key: keyBytes,
  };
}

/**
 * Checked at startup rather than at the first login: a hash nobody can ever
 * match is a misconfiguration, and misconfiguration is a refusal to start.
 */
export function assertUsablePasswordHash(stored: string): void {
  if (parse(stored) === undefined) {
    throw new Error(
      'Dogpark cannot start: DOGPARK_PASSWORD_HASH is not a scrypt hash of the form ' +
        'scrypt$N$r$p$salt$key. Mint one with `node dist/server.js hash-password <password>`.',
    );
  }
}

export function verifyPassword(stored: string, password: string): boolean {
  const parsed = parse(stored);
  if (parsed === undefined) return false;
  // `maxmem` scales with N*r*128; the default 32MB rejects the parameters
  // above, so it is raised rather than the work factor lowered.
  const derived = scryptSync(password, parsed.salt, parsed.key.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: 256 * parsed.n * parsed.r,
  });
  return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
}
