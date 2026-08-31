/**
 * The admin API as this UI understands it. The wire shapes are no longer
 * declared here: they are the response schemas in `src/types.ts` (the single
 * source of truth), re-exported below so screen imports stay stable. What
 * remains local is UI-only — the error envelope, the generic page, and the
 * client's own method arguments (which carry `File`s and cursors the wire does
 * not).
 */
import type {
  AgentId,
  ConversationId,
  ErrorCode,
  Escalation,
  SpaceId,
} from '../../../src/types.js';

export type {
  // Domain
  Agent,
  AgentId,
  Attachment,
  AttachmentId,
  Conversation,
  ConversationAnnotations,
  ConversationId,
  Message,
  MessageId,
  MessagePage,
  Sender,
  Space,
  SpaceId,
  Timestamp,
  // Admin wire shapes
  AdminAgent,
  ApiKeySummary,
  ConversationSummary,
  HumanCatchUpConversation,
  HumanCatchUpPage,
  CurrentMembership,
  Escalation,
  EscalationId,
  IssuedKey,
  NotificationState,
  NotificationStatus,
  PastMembership,
  ReadLogEntry,
  SearchResult,
  SessionCredentials,
  SpaceMembers,
  SpaceSummary,
  // The human's post lands in the same shape an agent's does.
  PostResult as HumanPostResult,
} from '../../../src/types.js';

export type ExportKind = 'conversation' | 'space';
export type ExportFormat = 'markdown' | 'json' | 'bundle';

/**
 * A protocol error body that reached the client, with the transport status it
 * arrived on. `status` is not part of the contract's error body; it is what
 * the UI has to route on when a body is missing or unparseable.
 */
export class ApiError extends Error {
  readonly code: ErrorCode | 'network' | 'unknown';
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(args: {
    code: ErrorCode | 'network' | 'unknown';
    message: string;
    status: number;
    retryAfterSeconds?: number | undefined;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.code = args.code;
    this.status = args.status;
    this.retryAfterSeconds = args.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Posting as the human
// ---------------------------------------------------------------------------

/** The post body with files as `File`s, sent multipart in the agent route's form. */
export interface HumanPostRequest {
  readonly target:
    { readonly conversation: ConversationId } | { readonly space: SpaceId; readonly title: string };
  readonly body: string;
  readonly idempotencyKey: string;
  readonly files?: readonly File[] | undefined;
  readonly complete?: true | undefined;
  readonly pin?: true | undefined;
}

// ---------------------------------------------------------------------------
// Paging and filters — the client's own arguments, not wire bodies
// ---------------------------------------------------------------------------

/** One page of a keyset-paged list; `nextCursor` continues it, `hasMore` says whether to. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ReadLogFilter {
  readonly agent?: AgentId | undefined;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

export interface EscalationFilter {
  readonly order?: 'oldest' | 'newest' | undefined;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

/** The inbox page, with the counts taken over the whole table, not the page. */
export interface EscalationPage extends Page<Escalation> {
  /** The headline: escalations nobody has settled yet. */
  readonly unacknowledged: number;
  /** Delivery detail beside it: rows the webhook has not sent. */
  readonly undelivered: number;
  /** Whether a webhook is configured at all; without one, delivery state is noise. */
  readonly webhookConfigured: boolean;
}

export type SearchOrder = 'relevance' | 'newest';

export interface SearchQuery {
  readonly q: string;
  readonly space?: SpaceId | undefined;
  readonly order?: SearchOrder | undefined;
  readonly after?: string | undefined;
}
