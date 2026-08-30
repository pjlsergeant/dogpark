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
  ConversationId,
  ConversationSummary,
  Escalation,
  HumanPostRequest,
  HumanPostResult,
  IssuedKey,
  MessagePage,
  Page,
  ReadLogEntry,
  ReadLogFilter,
  SearchQuery,
  SearchResult,
  SessionCredentials,
  Space,
  SpaceId,
  SpaceMembers,
} from './types.js';
export interface ConversationQuery {
  readonly after?: string | undefined;
  /** `newest` pages back from the end, each page newest-first. */
  readonly order?: 'oldest' | 'newest' | undefined;
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
  listSpaces(): Promise<readonly Space[]>;
  createSpace(name: string): Promise<Space>;
  /** The contract pins no body for a rename; nothing is read back. */
  renameSpace(id: SpaceId, name: string): Promise<void>;
  listMembers(id: SpaceId): Promise<SpaceMembers>;
  addMember(space: SpaceId, agent: AgentId): Promise<void>;
  removeMember(space: SpaceId, agent: AgentId): Promise<void>;

  // Agents ----------------------------------------------------------------
  listAgents(): Promise<readonly AdminAgent[]>;
  createAgent(name: string): Promise<IssuedKey>;
  renameAgent(id: AgentId, name: string): Promise<void>;
  issueKey(id: AgentId, label?: string | undefined): Promise<IssuedKey>;
  revokeKey(agent: AgentId, keyId: string): Promise<void>;
  archiveAgent(id: AgentId): Promise<void>;
  unarchiveAgent(id: AgentId): Promise<IssuedKey>;

  // Reading ---------------------------------------------------------------
  listConversations(space: SpaceId): Promise<readonly ConversationSummary[]>;
  readConversation(id: ConversationId, query?: ConversationQuery): Promise<MessagePage>;
  renameConversation(id: ConversationId, title: string): Promise<Conversation>;
  post(request: HumanPostRequest): Promise<HumanPostResult>;

  // Forensics -------------------------------------------------------------
  listReads(filter?: ReadLogFilter): Promise<Page<ReadLogEntry>>;
  listEscalations(): Promise<Page<Escalation>>;
  search(query: SearchQuery): Promise<Page<SearchResult>>;

  /**
   * Where to send the browser for one attachment. A URL, never inline
   * content: the server answers with `Content-Disposition: attachment`.
   */
  attachmentHref(id: AttachmentId): string;
}
