import type { ErrorCode } from '../types.js';
import { StoreError } from '../store/index.js';

/**
 * `ErrorCode` has no code for "Dogpark broke", because nothing an agent can
 * do produces one. A 500 still has to carry a body of the documented shape,
 * so there is exactly one code here that the protocol does not name.
 */
export type WireErrorCode = ErrorCode | 'internal';

const STATUS: Record<WireErrorCode, number> = {
  not_found: 404,
  unauthenticated: 401,
  invalid_request: 400,
  reserved_sequence: 422,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
};

export interface WireError {
  readonly status: number;
  readonly body: {
    readonly code: WireErrorCode;
    readonly message: string;
    readonly retryAfterSeconds?: number;
  };
}

export class HttpError extends Error {
  readonly code: WireErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: WireErrorCode,
    message: string,
    options: { readonly status?: number; readonly retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = options.status ?? STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * The only shape a caller ever gets for something it may not see. Kept as one
 * function so no route can accidentally distinguish "absent" from "not yours"
 * by wording (ADR-0003).
 */
export function notFound(what: string): HttpError {
  return new HttpError('not_found', `${what} not found`);
}

export function unauthenticated(message = 'authentication required'): HttpError {
  return new HttpError('unauthenticated', message);
}

export function invalid(message: string): HttpError {
  return new HttpError('invalid_request', message);
}

export function tooLarge(message: string): HttpError {
  return new HttpError('too_large', message);
}

/**
 * A refused CSRF token is not "not found": the caller is authenticated and the
 * resource is one it may see. 403 with `invalid_request` says the request was
 * malformed rather than the fleet mapped.
 */
export function csrfRefused(message: string): HttpError {
  return new HttpError('invalid_request', message, { status: 403 });
}

interface StatusCarrier {
  readonly statusCode: number;
  readonly message?: string;
}

function hasStatusCode(error: unknown): error is StatusCarrier {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  );
}

const BY_STATUS: Record<number, WireErrorCode> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'invalid_request',
  404: 'not_found',
  405: 'invalid_request',
  406: 'invalid_request',
  413: 'too_large',
  415: 'invalid_request',
  422: 'invalid_request',
  429: 'rate_limited',
};

/**
 * One funnel. Store failures already carry the right code — the store is the
 * layer that knows when "not yours" has to look like "not found" — and
 * Fastify's own failures (bad JSON, oversized body, wrong media type) are
 * translated by status so they do not leak framework wording as a code.
 */
export function toWireError(error: unknown): WireError {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
      },
    };
  }

  if (error instanceof StoreError) {
    return { status: STATUS[error.code], body: { code: error.code, message: error.message } };
  }

  if (hasStatusCode(error)) {
    const code = BY_STATUS[error.statusCode] ?? 'internal';
    const message = code === 'internal' ? 'internal error' : (error.message ?? 'request refused');
    return { status: code === 'internal' ? 500 : error.statusCode, body: { code, message } };
  }

  // Deliberately opaque: an unexpected failure says nothing about the fleet.
  return { status: 500, body: { code: 'internal', message: 'internal error' } };
}
