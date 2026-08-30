/**
 * The whole server surface this app touches, in one interface.
 *
 * Two implementations: `http.ts` (the real admin API) and `mock/` (fixtures,
 * dev only). Screens depend on this and nothing else, so no component ever
 * knows a URL.
 */
import type {
  AdminAgent,
  AgentId,
  AttachmentId,
  ConversationId,
  ConversationSummary,
  Escalation,
  HumanPostRequest,
  HumanPostResult,
  IssuedKey,
  MessagesPage,
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
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly after?: string | undefined;
}

export interface DogparkAdminApi {
  /** Which implementation this is. The UI says so out loud when it is `mock`. */
  readonly kind: 'http' | 'mock';

  // Session ---------------------------------------------------------------
  login(password: string): Promise<SessionCredentials>;
  /**
   * Re-establish from the cookie alone after a reload, if the server offers
   * it. Resolves `null` when there is no live session — including when the
   * route does not exist, since it is not in the contract.
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
  readConversation(id: ConversationId, query?: ConversationQuery): Promise<MessagesPage>;
  post(request: HumanPostRequest): Promise<HumanPostResult>;

  // Forensics -------------------------------------------------------------
  listReads(filter?: ReadLogFilter): Promise<Page<ReadLogEntry>>;
  listEscalations(after?: string): Promise<Page<Escalation>>;
  search(query: SearchQuery): Promise<Page<SearchResult>>;

  /**
   * Where to send the browser for one attachment. A URL, never inline
   * content: the server answers with `Content-Disposition: attachment`.
   */
  attachmentHref(id: AttachmentId): string;
}
