/**
 * The whole server surface this app touches, in one interface.
 *
 * Implemented by `http.ts`. Screens depend on this and nothing else, so no
 * component ever knows a URL.
 */
import type {
  AdminAgent,
  AgentId,
  AttachmentId,
  Conversation,
  ConversationAnnotations,
  ConversationId,
  ConversationSummary,
  Escalation,
  EscalationFilter,
  EscalationId,
  EscalationPage,
  HumanPostRequest,
  HumanPostResult,
  HumanCatchUpPage,
  IssuedKey,
  MessagePage,
  MessageId,
  Page,
  ReadLogEntry,
  ReadLogFilter,
  SearchQuery,
  SearchResult,
  SessionCredentials,
  Space,
  SpaceSummary,
  SpaceId,
  SpaceMembers,
  ExportFormat,
  ExportKind,
} from './types.js';
export interface ConversationQuery {
  readonly after?: string | undefined;
  /** `newest` pages back from the end, each page newest-first. */
  readonly order?: 'oldest' | 'newest' | undefined;
  /**
   * A read-log row id: render the thread as it read then, with the labels in
   * force at that read (ADR-0004). Nothing is logged.
   */
  readonly asOf?: string | undefined;
}

export interface DogparkAdminApi {
  // Session ---------------------------------------------------------------
  login(password: string): Promise<SessionCredentials>;
  /**
   * Re-establish from the cookie alone after a reload. Resolves `null` when
   * there is no live session, which is a state rather than an error.
   */
  resume(): Promise<SessionCredentials | null>;
  logout(): Promise<void>;

  // Spaces ----------------------------------------------------------------
  listSpaces(): Promise<readonly SpaceSummary[]>;
  /**
   * Resolves once something has been written since `after` — a post, a
   * membership change — or when `waitSeconds` run out, with the version to
   * pass next time. The app holds one of these open while it is visible and
   * refreshes what a write can move when it returns.
   */
  awaitChanges(
    after: string | undefined,
    waitSeconds: number,
    signal?: AbortSignal | undefined,
  ): Promise<string>;
  createSpace(name: string): Promise<Space>;
  /** The contract pins no body for a rename; nothing is read back. */
  renameSpace(id: SpaceId, name: string): Promise<void>;
  setSpaceDescription(id: SpaceId, description: string): Promise<void>;
  listMembers(id: SpaceId): Promise<SpaceMembers>;
  addMember(space: SpaceId, agent: AgentId): Promise<void>;
  removeMember(space: SpaceId, agent: AgentId): Promise<void>;

  // Agents ----------------------------------------------------------------
  listAgents(): Promise<readonly AdminAgent[]>;
  createAgent(name: string): Promise<IssuedKey>;
  renameAgent(id: AgentId, name: string): Promise<void>;
  setAgentDescription(id: AgentId, description: string): Promise<void>;
  setMembershipNote(space: SpaceId, agent: AgentId, description: string): Promise<void>;
  issueKey(id: AgentId, label?: string | undefined): Promise<IssuedKey>;
  revokeKey(agent: AgentId, keyId: string): Promise<void>;
  archiveAgent(id: AgentId): Promise<void>;
  unarchiveAgent(id: AgentId): Promise<IssuedKey>;

  // Reading ---------------------------------------------------------------
  listConversations(space: SpaceId): Promise<readonly ConversationSummary[]>;
  readConversation(id: ConversationId, query?: ConversationQuery): Promise<MessagePage>;
  listCatchUp(after?: string | undefined): Promise<HumanCatchUpPage>;
  /** The newest message the thread view has displayed; forward-only server-side. */
  advanceReadMark(conversation: ConversationId, message: MessageId): Promise<void>;
  markAllRead(through: number): Promise<void>;
  renameConversation(id: ConversationId, title: string): Promise<Conversation>;
  post(request: HumanPostRequest): Promise<HumanPostResult>;
  /**
   * Each takes the idempotency key of the attempt. A retry after a lost
   * answer replays under the same key: the server applies nothing again and
   * answers the state now — which, if someone reopened meanwhile, is `open`,
   * shown rather than overridden.
   */
  completeConversation(
    id: ConversationId,
    idempotencyKey: string,
  ): Promise<ConversationAnnotations>;
  reopenConversation(id: ConversationId, idempotencyKey: string): Promise<ConversationAnnotations>;
  pinMessage(
    id: ConversationId,
    message: MessageId,
    idempotencyKey: string,
  ): Promise<ConversationAnnotations>;
  unpinConversation(id: ConversationId, idempotencyKey: string): Promise<ConversationAnnotations>;

  // Forensics -------------------------------------------------------------
  listReads(filter?: ReadLogFilter): Promise<Page<ReadLogEntry>>;
  getRead(id: string): Promise<ReadLogEntry>;
  listEscalations(filter?: EscalationFilter): Promise<EscalationPage>;
  /** Settle one; idempotent, so a double-click is harmless. Returns the settled row. */
  acknowledgeEscalation(id: EscalationId): Promise<Escalation>;
  search(query: SearchQuery): Promise<Page<SearchResult>>;

  /**
   * Where to send the browser for one attachment. A URL, never inline
   * content: the server answers with `Content-Disposition: attachment`.
   */
  attachmentHref(id: AttachmentId): string;
  exportUrl(kind: ExportKind, id: string, format: ExportFormat): string;
}
