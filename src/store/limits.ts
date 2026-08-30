/**
 * The most rows one store read returns, whatever it is asked for. The HTTP
 * layer caps against `Limits.maxPageSize`, which configuration bounds to this,
 * so the advertised limit is always the honoured one.
 */
export const MAX_PAGE_LIMIT = 1000;
