import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * What `readSecret` needs of stdin: the bytes, and — when it is a terminal —
 * the switch that stops the terminal echoing them.
 */
export interface SecretInput extends AsyncIterable<Buffer | string> {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
}

export interface SecretOutput {
  write(text: string): unknown;
}

/**
 * A password read from stdin rather than argv, where it would be visible in
 * process listings and land in shell history. Piped: everything up to a single
 * trailing newline. A terminal: prompted for with echo off, ended by Enter,
 * abandoned by Ctrl-C or Ctrl-D.
 */
export async function readSecret(input: SecretInput, output: SecretOutput): Promise<string> {
  if (input.isTTY !== true) {
    let text = '';
    for await (const chunk of input) text += typeof chunk === 'string' ? chunk : chunk.toString();
    return text.replace(/\r?\n$/, '');
  }

  output.write('Password: ');
  input.setRawMode?.(true);
  let text = '';
  try {
    for await (const chunk of input) {
      const keys = typeof chunk === 'string' ? chunk : chunk.toString();
      for (const key of keys) {
        if (key === '\r' || key === '\n') return text;
        if (key === '\u0003' || key === '\u0004') throw new Error('interrupted');
        if (key === '\u007f' || key === '\b') text = text.slice(0, -1);
        else text += key;
      }
    }
    return text;
  } finally {
    input.setRawMode?.(false);
    output.write('\n');
  }
}

/**
 * `DOGPARK_PASSWORD_HASH` is scrypt, because Node has it in core and a native
 * argon2 dependency buys little in a container that already builds
 * better-sqlite3:
 *
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<derived key base64url>
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
        'scrypt$N$r$p$salt$key. Mint one with `node dist/server.js hash-password`.',
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
