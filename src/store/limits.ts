import { invalid } from './errors.js';

/**
 * The most rows one store read returns, whatever it is asked for. The HTTP
 * layer caps against `Limits.maxPageSize`, which configuration bounds to this,
 * so the advertised limit is always the honoured one.
 */
export const MAX_PAGE_LIMIT = 1000;

const DEFAULT_LIMIT = 100;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer');
  return Math.min(limit, MAX_PAGE_LIMIT);
}
