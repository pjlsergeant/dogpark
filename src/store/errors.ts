import type { ErrorCode } from '../types.js';

/**
 * A failure the HTTP layer can turn straight into a `DogparkError`. The store
 * chooses the code because it is the layer that knows why: in particular it is
 * the layer that decides when "not yours" has to look like `not_found`, so
 * error codes cannot map the fleet (ADR-0003).
 */
export class StoreError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export function notFound(what: string): StoreError {
  // Deliberately uniform: "does not exist" and "exists but is not yours" are
  // the same answer.
  return new StoreError('not_found', `${what} not found`);
}

export function invalid(message: string): StoreError {
  return new StoreError('invalid_request', message);
}
