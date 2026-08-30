/**
 * Rendering a stored row to a `Message`: labels resolved on the way out
 * (ADR-0014), optionally as they stood at a label-history position.
 */
import type {
  AgentId,
  Attachment,
  AttachmentId,
  ConversationId,
  EventId,
  Message,
  MessageId,
  Sender,
  SpaceId,
  SystemEvent,
  Timestamp,
} from '../types.js';
import type { StoreContext } from './context.js';
import type { EventRow, MessageRow } from './statements.js';
import { encodeMentions, parseMentions, renderMentions } from './text.js';

/**
 * A per-call cache: one page can hold many messages from one conversation
 * written by one sender, and each of those is a label lookup.
 */
export interface RenderCache {
  titles: Map<string, string>;
  names: Map<string, string>;
  mentionNames: Map<string, string | undefined>;
  /** Render labels as they stood at this label-history position; absent means now. */
  labelSeq: number | undefined;
}

export function createRenderer(ctx: StoreContext) {
  const { st, humanDisplayName, toSpace } = ctx;

  function newRenderCache(labelSeq?: number): RenderCache {
    return { titles: new Map(), names: new Map(), mentionNames: new Map(), labelSeq };
  }

  /** `current` unless a rename after `cache.labelSeq` says the label was different then. */
  function labelAsOf(cache: RenderCache, kind: string, subject: string, current: string): string {
    if (cache.labelSeq === undefined) return current;
    return st.labelAsOf.get({ kind, subject, labelSeq: cache.labelSeq })?.label ?? current;
  }

  function conversationTitle(cache: RenderCache, id: string): string {
    const cached = cache.titles.get(id);
    if (cached !== undefined) return cached;
    const row = st.getConversation.get({ id });
    /* c8 ignore next */
    if (row === undefined) throw new Error(`message references a missing conversation ${id}`);
    const title = labelAsOf(cache, 'conversation', id, row.title);
    cache.titles.set(id, title);
    return title;
  }

  function agentName(cache: RenderCache, id: string): string {
    const cached = cache.names.get(id);
    if (cached !== undefined) return cached;
    const row = st.getAgent.get({ id });
    /* c8 ignore next */
    if (row === undefined) throw new Error(`message references a missing agent ${id}`);
    const name = labelAsOf(cache, 'agent', id, row.display_name);
    cache.names.set(id, name);
    return name;
  }

  function mentionName(cache: RenderCache, space: string, agent: AgentId): string | undefined {
    const key = `${space}:${agent}`;
    if (cache.mentionNames.has(key)) return cache.mentionNames.get(key);
    const row = st.resolveMentionRef.get({ space, agent });
    const name = row === undefined ? undefined : labelAsOf(cache, 'agent', agent, row.display_name);
    cache.mentionNames.set(key, name);
    return name;
  }

  function toMessage(row: MessageRow, cache: RenderCache): Message {
    const resolve = (agent: AgentId): string | undefined => mentionName(cache, row.space_id, agent);
    const sender: Sender =
      row.sender_agent_id === null
        ? { kind: 'human', displayName: humanDisplayName }
        : {
            kind: 'agent',
            id: row.sender_agent_id as AgentId,
            displayName: agentName(cache, row.sender_agent_id),
          };
    return {
      kind: 'message',
      id: row.id as MessageId,
      space: row.space_id as SpaceId,
      conversation: row.conversation_id as ConversationId,
      conversationTitle: conversationTitle(cache, row.conversation_id),
      sender,
      body: renderMentions(row.body, resolve),
      mentions: parseMentions(row.body, (agent) => resolve(agent) !== undefined),
      attachments: toAttachments(row.id),
      sentAt: row.sent_at as Timestamp,
    };
  }

  function toAttachments(messageId: string): readonly Attachment[] {
    return st.attachmentsFor.all({ message: messageId }).map((a) => ({
      id: a.id as AttachmentId,
      filename: a.filename,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
    }));
  }

  function toEvent(row: EventRow): SystemEvent {
    if (row.kind === 'space_access_granted') {
      // The space itself, not just its id: an agent just introduced to one
      // should not need another call to learn what it is called.
      const space = st.getSpace.get({ id: row.space_id });
      /* c8 ignore next */
      if (space === undefined) throw new Error(`event references a missing space ${row.space_id}`);
      return {
        kind: 'space_access_granted',
        id: row.id as EventId,
        space: toSpace(space),
        at: row.created_at as Timestamp,
      };
    }
    return {
      kind: 'space_access_revoked',
      id: row.id as EventId,
      space: row.space_id as SpaceId,
      at: row.created_at as Timestamp,
    };
  }

  function canonicalBody(space: SpaceId, body: string): string {
    return encodeMentions(body, (name) => {
      const row = st.resolveMentionName.get({ space, name });
      return row === undefined ? undefined : (row.id as AgentId);
    });
  }

  return { newRenderCache, mentionName, toMessage, toEvent, canonicalBody };
}

export type Renderer = ReturnType<typeof createRenderer>;
