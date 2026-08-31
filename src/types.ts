/**
 * The Dogpark protocol, stated as zod schemas — the single source of truth for
 * every request and response body on the wire, agent-facing and admin alike.
 *
 * The TypeScript types are inferred from the schemas (`z.infer`) and exported
 * under the names the rest of the code already uses, so one definition drives
 * three things that used to drift apart: the server's response construction
 * (checked by the compiler through `src/http/shapes.ts`), the smoke tests that
 * `.parse()` real responses (`src/http/app.test.ts`), and the UI's decoding
 * (`ui/src/api/types.ts` re-exports these, `ui/src/api/http.ts` parses with
 * them). See docs/architecture.md and docs/http-api.md.
 *
 * This module is isomorphic: it imports nothing from `src/store` or anything
 * Node-specific, so the browser bundle can import it directly.
 *
 * Response schemas are non-strict (`z.object`): a server may add a field
 * without breaking an old parser. Request schemas keep `strictObject`, so an
 * unknown query parameter is still rejected rather than ignored.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Branded ids
//
// A branded id on the wire is just a string; the brand is a type-level tag that
// stops one id being passed where another belongs. Zod is not contorted to
// carry the brand — the schema validates a string and the brand is applied at
// the inferred-type layer (ADR-0013 explains why type confusion is caught here
// rather than by an id prefix).
// ---------------------------------------------------------------------------

/** A string on the wire, branded only in the type. */
const branded = <T extends string>(): z.ZodType<T> => z.string() as unknown as z.ZodType<T>;

/**
 * Stable identity for an agent.
 *
 * An agent is a role, not a process: the implementation behind it is expected
 * to change while the identity persists, so its history stays coherent
 * (ADR-0013).
 */
export type AgentId = string & { readonly __brand: 'AgentId' };

/**
 * A visibility boundary: the set of agents that can see one another's
 * messages. The unit of isolation.
 */
export type SpaceId = string & { readonly __brand: 'SpaceId' };

/**
 * One thread of discussion inside a space. Not itself a boundary.
 *
 * Its title can change; this cannot. Messages store this, never the title.
 */
export type ConversationId = string & { readonly __brand: 'ConversationId' };

export type MessageId = string & { readonly __brand: 'MessageId' };

/** Identifies one attachment for retrieval. An opaque handle. */
export type AttachmentId = string & { readonly __brand: 'AttachmentId' };

export type EventId = string & { readonly __brand: 'EventId' };

/** One escalation in the human's inbox. */
export type EscalationId = string & { readonly __brand: 'EscalationId' };

/**
 * An opaque position in an agent's stream. A token: not a timestamp, and not
 * ordered arithmetic.
 *
 * A position is where an agent got to, not what it consumed — `ReadFrom` lets
 * it seek. The read log records the parameters of each read, so a jump is
 * distinguishable from a span (ADR-0005).
 */
export type Cursor = string & { readonly __brand: 'Cursor' };

/**
 * An opaque position within one query's results. Distinct from `Cursor`: a
 * stream position means nothing to a query and vice versa, and sharing one
 * brand made passing the wrong one type-legal.
 */
export type QueryCursor = string & { readonly __brand: 'QueryCursor' };

/** An ISO-8601 timestamp, e.g. `2026-08-30T10:35:00Z`. */
export type Timestamp = string & { readonly __brand: 'Timestamp' };

/**
 * Caller-supplied key making a write safe to retry. A replayed key returns the
 * original result; replaying one with a different request is rejected. Scoped
 * per writer, so one agent's key never collides with another's.
 */
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

export const ConversationStatusSchema = z.enum(['open', 'complete']);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

// ---------------------------------------------------------------------------
// Domain objects
// ---------------------------------------------------------------------------

/**
 * Who sent a message. One human per deployment, so no further identity is
 * carried for them. Attribution, not authority (ADR-0006).
 */
export const SenderSchema = z.union([
  z
    .object({ kind: z.literal('agent'), id: branded<AgentId>(), displayName: z.string() })
    .readonly(),
  z.object({ kind: z.literal('human'), displayName: z.string() }).readonly(),
]);
export type Sender = z.infer<typeof SenderSchema>;

export const ConversationPinSchema = z
  .object({ message: branded<MessageId>(), actor: SenderSchema })
  .readonly();
export type ConversationPin = z.infer<typeof ConversationPinSchema>;

export const ConversationAnnotationsSchema = z
  .object({ status: ConversationStatusSchema, pins: z.array(ConversationPinSchema).readonly() })
  .readonly();
export type ConversationAnnotations = z.infer<typeof ConversationAnnotationsSchema>;

export const AttachmentSchema = z
  .object({
    id: branded<AttachmentId>(),
    filename: z.string(),
    contentType: z.string(),
    sizeBytes: z.number(),
  })
  .readonly();
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Messages are immutable: there is no edit or delete. */
export const MessageSchema = z
  .object({
    kind: z.literal('message'),
    id: branded<MessageId>(),
    /** Derived from the conversation, carried so a stream reader can route. */
    space: branded<SpaceId>(),
    /**
     * The conversation's current title, rendered like any other label. Without
     * it an agent reading a stream can group messages by id but never learn what
     * any thread is called.
     */
    conversationTitle: z.string(),
    conversation: branded<ConversationId>(),
    sender: SenderSchema,
    /**
     * Markdown, with mentions rendered from references — so two reads can differ
     * if an agent was renamed between them (ADR-0014). Never contains the
     * reserved sequence.
     */
    body: z.string(),
    /**
     * Agents named with `@name`, resolved by Dogpark so callers do not parse
     * text. Marks intent; does not affect delivery. A name resolves only within
     * the space, and an unresolvable one stays literal rather than erroring.
     *
     * Derived from the stored body, which holds references rather than names —
     * not stored separately.
     */
    mentions: z.array(branded<AgentId>()).readonly(),
    attachments: z.array(AttachmentSchema).readonly(),
    sentAt: branded<Timestamp>(),
  })
  .readonly();
export type Message = z.infer<typeof MessageSchema>;

export const SpaceSchema = z.object({ id: branded<SpaceId>(), name: z.string() }).readonly();
export type Space = z.infer<typeof SpaceSchema>;

export const ConversationSchema = z
  .object({ id: branded<ConversationId>(), space: branded<SpaceId>(), title: z.string() })
  .readonly();
export type Conversation = z.infer<typeof ConversationSchema>;

export const AgentSchema = z.object({ id: branded<AgentId>(), displayName: z.string() }).readonly();
export type Agent = z.infer<typeof AgentSchema>;

export const AgentListingSchema = z
  .object({
    id: branded<AgentId>(),
    displayName: z.string(),
    description: z.string().optional(),
    /** Present only when `/agents` was filtered to one space. */
    note: z.string().optional(),
  })
  .readonly();
export type AgentListing = z.infer<typeof AgentListingSchema>;

export const IdentitySpaceSchema = z
  .object({
    id: branded<SpaceId>(),
    name: z.string(),
    description: z.string().optional(),
    note: z.string().optional(),
  })
  .readonly();
export type IdentitySpace = z.infer<typeof IdentitySpaceSchema>;

/**
 * Something that happened to this agent rather than something someone said.
 * Gaining access does not replay a space's history: the event says the space
 * is there, and the agent decides whether to backfill (ADR-0009).
 *
 * Events are exempt from the current-access filter that hides messages,
 * because they describe the agent's relationship to a space rather than its
 * contents — otherwise a revocation would delete the event announcing it.
 */
export const SystemEventSchema = z.union([
  z
    .object({
      kind: z.literal('space_access_granted'),
      id: branded<EventId>(),
      /** The space itself, not just its id: an agent just introduced to one
       * should not need another call to learn what it is called. */
      space: SpaceSchema,
      at: branded<Timestamp>(),
    })
    .readonly(),
  z
    .object({
      kind: z.literal('space_access_revoked'),
      id: branded<EventId>(),
      space: branded<SpaceId>(),
      at: branded<Timestamp>(),
    })
    .readonly(),
]);
export type SystemEvent = z.infer<typeof SystemEventSchema>;

export const StreamItemSchema = z.union([MessageSchema, SystemEventSchema]);
export type StreamItem = z.infer<typeof StreamItemSchema>;

/**
 * Not reproducible: the same cursor can yield different items on a later call,
 * because messages are filtered against membership as it stands at read time.
 * A space revoked since the last read is skipped and the cursor moves past it
 * (ADR-0009).
 */
export const StreamPageSchema = z
  .object({
    items: z.array(StreamItemSchema).readonly(),
    /**
     * Position after the last item. Always present, including for an empty page,
     * so an agent can keep waiting without losing its place.
     */
    nextCursor: branded<Cursor>(),
    /** True when more is already available; false when the agent is caught up. */
    hasMore: z.boolean(),
  })
  .readonly();
export type StreamPage = z.infer<typeof StreamPageSchema>;

export const MessagePageSchema = z
  .object({
    messages: z.array(MessageSchema).readonly(),
    nextCursor: branded<QueryCursor>(),
    hasMore: z.boolean(),
    annotations: ConversationAnnotationsSchema.optional(),
  })
  .readonly();
export type MessagePage = z.infer<typeof MessagePageSchema>;

export const LimitsSchema = z
  .object({
    maxMessageBytes: z.number(),
    maxAttachmentBytes: z.number(),
    /** Files on one message. Each is bounded by `maxAttachmentBytes` on its own. */
    maxAttachmentsPerMessage: z.number(),
    requestsPerMinute: z.number(),
    /** Most items a single read returns, however much is waiting. */
    maxPageSize: z.number(),
    /** Largest `waitSeconds` the server will honour on a stream read. */
    maxWaitSeconds: z.number(),
    maxDescriptionChars: z.number(),
  })
  .readonly();
export type Limits = z.infer<typeof LimitsSchema>;

/** Everything an agent needs to behave correctly, rather than discover by failing. */
export const IdentitySchema = z
  .object({
    self: AgentSchema,
    spaces: z.array(IdentitySpaceSchema).readonly(),
    limits: LimitsSchema,
    /**
     * Where this agent last read to, for one that kept no cursor between runs.
     * A hint, not an acknowledgement: it is the cursor of the newest stream
     * read *recorded*, and a read is recorded before its response is sent, so
     * a response lost in transit still advances it. Resuming from it is
     * therefore at-most-once. An agent that must not miss a page keeps its own
     * cursor and advances it only after processing. Absent until the agent has
     * read the stream: conversation, space and attachment reads are recorded
     * but carry no stream position.
     */
    lastReadCursor: branded<Cursor>().optional(),
    /**
     * A control character that must not appear in any text the agent submits.
     * Writes containing it are rejected rather than sanitised, so a client
     * flattening a conversation into a prompt has a delimiter no body can
     * contain (ADR-0010).
     */
    reservedSequence: z.string(),
  })
  .readonly();
export type Identity = z.infer<typeof IdentitySchema>;

// ---------------------------------------------------------------------------
// Structural protocol types that are not themselves JSON bodies. `ReadFrom`
// and `Range` are derived from query parameters (see `readFromQuery`,
// `rangeFromQuery`), `PostTarget` from a validated post body; all three carry
// branded ids and are consumed by the store rather than parsed off the wire.
// ---------------------------------------------------------------------------

/** Where to begin reading. Omit to start from the beginning. */
export type ReadFrom =
  | { readonly after: Cursor }
  /** A starting anchor only. Page with `nextCursor` thereafter. */
  | { readonly since: Timestamp }
  /**
   * Start at the live edge, discarding whatever is behind. For an agent that
   * has been a member for a year and never read: without this, its first call
   * is the whole year.
   */
  | { readonly from: 'tip' };

/**
 * A bounded range, for queries rather than streams. A reporting agent wants
 * "this space, last Tuesday" — an open-ended tail cannot express the far end.
 *
 * Paging within a range uses `after`, which is a position in that query's
 * results, not a position in the agent's stream.
 */
export interface Range {
  /** Inclusive. */
  readonly since?: Timestamp | undefined;
  /** Exclusive. */
  readonly until?: Timestamp | undefined;
  readonly after?: QueryCursor | undefined;
  /**
   * Oldest first by default. `newest` pages backwards from the end, which is
   * what anyone wanting recent context actually needs — an agent backfilling a
   * long thread wants its last fifty messages, not to walk forward from a
   * conversation's first day to reach today.
   */
  readonly order?: 'oldest' | 'newest' | undefined;
}

/**
 * Where a message goes: an existing thread, or a subject line within a space,
 * which opens that thread if new. Titles are unique within a space (ADR-0012).
 */
export type PostTarget =
  | { readonly conversation: ConversationId }
  /** A bootstrap: the post response carries the conversation, so use the id after. */
  | { readonly space: SpaceId; readonly title: string };

export type ErrorCode =
  /** Also returned for anything the agent is not entitled to see. */
  | 'not_found'
  | 'unauthenticated'
  | 'invalid_request'
  /** Submitted text contained the reserved sequence. */
  | 'reserved_sequence'
  /** Exceeded a limit from `Limits`; which one is in `message`. */
  | 'too_large'
  | 'rate_limited';

// ---------------------------------------------------------------------------
// Request bodies and query strings
//
// Ids are not pattern-checked: an id the store does not know is `not_found`,
// and a stricter answer for a malformed one would tell a prober that its guess
// was at least the right shape. `strictObject` throughout, so an unknown query
// parameter is rejected rather than ignored.
// ---------------------------------------------------------------------------

const Id = z.string().min(1).max(128);

/**
 * The same ceiling whichever door a title comes through: a thread opened by a
 * post target and one renamed afterwards are the same title.
 */
export const MAX_TITLE_CHARS = 200;
/**
 * A reason is the agent's own words and goes into a webhook payload, so it is
 * bounded like a title rather than like a body.
 */
export const MAX_REASON_CHARS = 2000;

export const Target = z.union([
  z.strictObject({ conversation: Id }),
  z.strictObject({ space: Id, title: z.string().min(1).max(MAX_TITLE_CHARS) }),
]);

export const PostBody = z.strictObject({
  target: Target,
  body: z.string(),
  idempotencyKey: z.string().min(1).max(200),
  complete: z.literal(true).optional(),
  pin: z.literal(true).optional(),
});

/** The human's post. The key is optional — a browser need not mint one — and
 * durable when given, like an agent's. */
export const HumanPostBody = z.strictObject({
  target: Target,
  body: z.string(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  complete: z.literal(true).optional(),
  pin: z.literal(true).optional(),
});

export const AnnotationActionBody = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
});
export const HumanAnnotationActionBody = z.strictObject({
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export const PinBody = AnnotationActionBody.extend({ messageId: Id });
export const HumanPinBody = HumanAnnotationActionBody.extend({ messageId: Id });

export const EscalateBody = z.strictObject({
  conversation: Id,
  reason: z.string().min(1).max(MAX_REASON_CHARS),
  idempotencyKey: z.string().min(1).max(200),
});

export const NameBody = z.strictObject({ name: z.string().min(1).max(128) });
export const DescriptionBody = z.strictObject({ description: z.string() });
export const TitleBody = z.strictObject({ title: z.string().min(1).max(MAX_TITLE_CHARS) });
export const KeyBody = z.strictObject({ label: z.string().min(1).max(128).optional() });
export const PasswordBody = z.strictObject({ password: z.string().min(1).max(1024) });
export const HumanReadMarkBody = z.strictObject({
  conversation: Id,
  seq: z.number().int().nonnegative(),
});

export const StreamQuery = z.strictObject({
  after: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  tip: z.string().optional(),
  waitSeconds: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const RangeQuery = z.strictObject({
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  order: z.enum(['oldest', 'newest']).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const AgentsQuery = z.strictObject({ space: Id.optional() });

/** The human's long poll: the last version seen, and how long to wait past it. */
export const ChangesQuery = z.strictObject({
  /** Opaque: whatever the last answer said. */
  after: z.string().min(1).max(64).optional(),
  waitSeconds: z.coerce.number().int().nonnegative().optional(),
});

export const ReadLogQuery = z.strictObject({
  agent: Id.optional(),
  limit: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  after: z.string().optional(),
});

export const EscalationsQuery = z.strictObject({
  order: z.enum(['oldest', 'newest']).optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
export const CatchUpQuery = z.strictObject({
  after: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const SearchQuery = z.strictObject({
  q: z.string().min(1),
  space: Id.optional(),
  order: z.enum(['relevance', 'newest']).optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Agent-surface response bodies
// ---------------------------------------------------------------------------

/**
 * `POST /messages`: the message as it landed, and where. Addressing by title,
 * the conversation is how the agent learns the id.
 */
export const PostResultSchema = z
  .object({
    message: MessageSchema,
    conversation: ConversationSchema,
    annotations: ConversationAnnotationsSchema,
  })
  .readonly();
export type PostResult = z.infer<typeof PostResultSchema>;

// ---------------------------------------------------------------------------
// Admin-surface response bodies
//
// The shapes the smoke tests parse and `src/http/shapes.ts` constructs. Domain
// objects (`Agent`, `Conversation`, `Space`, `Sender`, `Message`) are shared
// with the agent surface above, so a label renders the same on both.
// ---------------------------------------------------------------------------

/**
 * The session routes: the CSRF token minted with the cookie, plus the human's
 * name. Both routes also carry `expiresAt`, which no client reads; a non-strict
 * response schema lets the server keep sending it without naming it here.
 */
export const SessionCredentialsSchema = z
  .object({ csrfToken: z.string(), displayName: z.string() })
  .readonly();
export type SessionCredentials = z.infer<typeof SessionCredentialsSchema>;

export const ApiKeySummarySchema = z
  .object({
    keyId: z.string(),
    label: z.string().nullable(),
    createdAt: branded<Timestamp>(),
    revokedAt: branded<Timestamp>().nullable(),
  })
  .readonly();
export type ApiKeySummary = z.infer<typeof ApiKeySummarySchema>;

/**
 * `hasEverAuthenticated` is `lastSeenAt !== null`, since the store sets
 * last-seen only on a successful verification. `failedAttemptsClaimingId`
 * counts attempts claiming this id — not attempts *by* this agent — and the UI
 * shows it prominently until the agent first authenticates, which is the window
 * where it diagnoses anything.
 */
export const AdminAgentSchema = z
  .object({
    id: branded<AgentId>(),
    displayName: z.string(),
    archived: z.boolean(),
    /** Null until the agent has authenticated successfully at least once. */
    lastSeenAt: branded<Timestamp>().nullable(),
    failedAttemptsClaimingId: z.number(),
    hasEverAuthenticated: z.boolean(),
    createdAt: branded<Timestamp>(),
    description: z.string().optional(),
    /** Every key ever issued to this agent, revoked ones included. */
    keys: z.array(ApiKeySummarySchema).readonly(),
  })
  .readonly();
export type AdminAgent = z.infer<typeof AdminAgentSchema>;

/** The one moment a key exists in plaintext: creating, issuing, unarchiving. */
export const IssuedKeySchema = z
  .object({
    /** `dgp_<agent-id>_<secret>`. Never retrievable again. */
    key: z.string(),
    keyId: z.string(),
    agent: AgentSchema,
  })
  .readonly();
export type IssuedKey = z.infer<typeof IssuedKeySchema>;

/** `GET /spaces`: a space with how much is in it and when it last moved. */
export const SpaceSummarySchema = z
  .object({
    id: branded<SpaceId>(),
    name: z.string(),
    conversationCount: z.number(),
    messageCount: z.number(),
    /** Null for a space nobody has posted in. */
    lastActivityAt: branded<Timestamp>().nullable(),
    description: z.string().optional(),
    unreadCount: z.number(),
  })
  .readonly();
export type SpaceSummary = z.infer<typeof SpaceSummarySchema>;

export const HumanCatchUpConversationSchema = z
  .object({
    id: branded<ConversationId>(),
    space: SpaceSchema,
    title: z.string(),
    unreadCount: z.number(),
    latestActivitySeq: z.number(),
    latestActivityAt: branded<Timestamp>(),
    lastSender: SenderSchema,
    status: ConversationStatusSchema,
    hasPins: z.boolean(),
  })
  .readonly();
export type HumanCatchUpConversation = z.infer<typeof HumanCatchUpConversationSchema>;

export const HumanCatchUpPageSchema = z
  .object({
    conversations: z.array(HumanCatchUpConversationSchema).readonly(),
    nextCursor: branded<QueryCursor>().nullable(),
    hasMore: z.boolean(),
  })
  .readonly();
export type HumanCatchUpPage = z.infer<typeof HumanCatchUpPageSchema>;

export const CurrentMembershipSchema = z
  .object({ agent: AgentSchema, grantedAt: branded<Timestamp>(), note: z.string().optional() })
  .readonly();
export type CurrentMembership = z.infer<typeof CurrentMembershipSchema>;

export const PastMembershipSchema = z
  .object({
    agent: AgentSchema,
    grantedAt: branded<Timestamp>(),
    revokedAt: branded<Timestamp>(),
  })
  .readonly();
export type PastMembership = z.infer<typeof PastMembershipSchema>;

/**
 * Membership is history: append-only intervals, the current set being the open
 * ones (ADR-0011), `history` the closed ones. Does not carry the space: a
 * screen showing one space's members names it from `GET /spaces`.
 */
export const SpaceMembersSchema = z
  .object({
    current: z.array(CurrentMembershipSchema).readonly(),
    history: z.array(PastMembershipSchema).readonly(),
  })
  .readonly();
export type SpaceMembers = z.infer<typeof SpaceMembersSchema>;

/**
 * One row of the human's thread list. `openedBy` (who first posted to the
 * subject line) and `lastSender` are whole `Sender`s rather than names, so the
 * UI renders an agent's current name rather than one frozen at the time.
 */
export const ConversationSummarySchema = z
  .object({
    id: branded<ConversationId>(),
    space: branded<SpaceId>(),
    title: z.string(),
    openedBy: SenderSchema,
    messageCount: z.number(),
    lastActivityAt: branded<Timestamp>().nullable(),
    /** Null on an empty thread, as is `lastActivityAt`. */
    lastSender: SenderSchema.nullable(),
    annotations: ConversationAnnotationsSchema,
  })
  .readonly();
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

/**
 * A read-log row, with what it read resolved far enough to link into the
 * reader: the conversation (and so its space) for a conversation read, the
 * space for a space read, both as current labels. `collapsedCount` and
 * `firstReadAt` appear only on a row that stands for a compacted run of empty
 * stream polls, so an ordinary row still reads as one read.
 */
export const ReadLogEntrySchema = z
  .object({
    id: z.string(),
    agent: AgentSchema,
    at: branded<Timestamp>(),
    kind: z.enum(['stream', 'conversation', 'space', 'attachment']),
    /** Opaque JSON, rendered structurally so a richer record still displays. */
    parameters: z.record(z.string(), z.unknown()),
    cursor: z.string(),
    itemCount: z.number(),
    /** How many reads a collapsed row stands for, and when that run began. */
    collapsedCount: z.number().optional(),
    firstReadAt: branded<Timestamp>().optional(),
    /** What a conversation read read, resolved so the reader can be opened as of it. */
    conversation: ConversationSchema.optional(),
    /** Likewise for a space read. */
    space: SpaceSchema.optional(),
  })
  .readonly();
export type ReadLogEntry = z.infer<typeof ReadLogEntrySchema>;

export const NotificationStateSchema = z.enum(['pending', 'sent', 'failed']);
export type NotificationState = z.infer<typeof NotificationStateSchema>;

/** The retry detail behind an escalation's notification. */
export const NotificationStatusSchema = z
  .object({
    state: NotificationStateSchema,
    attempts: z.number(),
    lastAttemptAt: branded<Timestamp>().nullable(),
    nextAttemptAt: branded<Timestamp>().nullable(),
    lastError: z.string().nullable(),
  })
  .readonly();
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

export const EscalationSchema = z
  .object({
    id: branded<EscalationId>(),
    agent: AgentSchema,
    conversation: ConversationSchema,
    reason: z.string(),
    raisedAt: branded<Timestamp>(),
    /** When the human settled it; null while it still wants one. */
    acknowledgedAt: branded<Timestamp>().nullable(),
    notification: NotificationStatusSchema,
  })
  .readonly();
export type Escalation = z.infer<typeof EscalationSchema>;

export const SearchResultSchema = z
  .object({
    message: MessageSchema,
    conversation: ConversationSchema,
    space: SpaceSchema,
    /** Agent-authored like the body; rendered as plain text. */
    snippet: z.string(),
  })
  .readonly();
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ---------------------------------------------------------------------------
// Keyset-paged list envelopes
//
// Each carries its rows under a route-specific key, plus the opaque
// `nextCursor` (kept even on an empty page) and `hasMore`.
// ---------------------------------------------------------------------------

export const ReadLogPageSchema = z
  .object({
    reads: z.array(ReadLogEntrySchema).readonly(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .readonly();

/**
 * The inbox page. `unacknowledged` (the headline: escalations nobody has
 * settled) and `undelivered` (the webhook has not sent) are counted over the
 * whole table, not the page, so a badge is right whatever page is showing.
 * `webhookConfigured` lets the UI drop delivery state entirely when there is no
 * webhook, since nothing was ever going to be sent.
 */
export const EscalationsResponseSchema = z
  .object({
    escalations: z.array(EscalationSchema).readonly(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    unacknowledged: z.number(),
    undelivered: z.number(),
    webhookConfigured: z.boolean(),
  })
  .readonly();

export const SearchResponseSchema = z
  .object({
    results: z.array(SearchResultSchema).readonly(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .readonly();

/** `GET /changes`: an opaque version that moves on every write the UI shows. */
export const ChangesResponseSchema = z.object({ version: z.string() }).readonly();
