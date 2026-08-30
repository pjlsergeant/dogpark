import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable field order, so the same request always hashes the same way. */
export function requestHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

/** For secrets and their hashes: a length mismatch is the only early exit. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
