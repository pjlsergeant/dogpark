import type { Config } from '../config.js';
import type { Store } from '../store/index.js';
import type { Limits } from '../types.js';
import type { AttachmentFiles } from './attachments.js';
import type { RateLimiter } from './rate-limit.js';
import type { WriteSignal } from './signal.js';

/** Everything the routes share, assembled once by `buildApp`. */
export interface AppContext {
  readonly store: Store;
  readonly config: Config;
  readonly limits: Limits;
  readonly files: AttachmentFiles;
  readonly writes: WriteSignal;
  readonly agentLimiter: RateLimiter;
  /** Login is not an agent call, so it is limited by source address instead. */
  readonly loginLimiter: RateLimiter;
  /**
   * Bounds how often a failed bearer authentication is counted — never whether
   * it is refused (ADR-0015). Keyed by source address and by the claimed id.
   */
  readonly failedAuthLimiter: RateLimiter;
  readonly secureCookies: boolean;
  /** Clamp a caller's asked-for page size to `limits.maxPageSize`. */
  readonly pageLimit: (asked: number | undefined) => number;
  readonly sessionTtlSeconds: number;
  readonly now: () => Date;
}

export function limitsFrom(config: Config): Limits {
  return {
    maxMessageBytes: config.DOGPARK_MAX_MESSAGE_BYTES,
    maxAttachmentBytes: config.DOGPARK_MAX_ATTACHMENT_BYTES,
    requestsPerMinute: config.DOGPARK_REQUESTS_PER_MINUTE,
    maxPageSize: config.DOGPARK_MAX_PAGE_SIZE,
    maxWaitSeconds: config.DOGPARK_MAX_WAIT_SECONDS,
  };
}
