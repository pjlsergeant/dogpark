/**
 * Every prepared statement, and the row shapes they return. Prepared once per
 * connection, after migration, and shared by the domain modules through
 * `StoreContext`.
 */
import type { Database as Db } from 'better-sqlite3';
import { SNIPPET_CLOSE, SNIPPET_OPEN } from './text.js';

/**
 * What the store uses of a prepared statement. Its own type rather than the
 * library's, whose exported `Statement` resolves to an unexported namespace
 * type that a declaration file cannot name. `P` is the bound parameters:
 * `[]` for none, otherwise one named-parameter object — `object` rather than
 * a `Record`, which an interface would not satisfy.
 */
export interface Prepared<P extends object | [], R> {
  get(...params: P extends [] ? [] : [P]): R | undefined;
  all(...params: P extends [] ? [] : [P]): R[];
  run(...params: P extends [] ? [] : [P]): { readonly changes: number };
}

export interface AgentRow {
  id: string;
  display_name: string;
  archived: number;
  created_at: string;
  last_seen_at: string | null;
  failed_auth_attempts: number;
}

export interface SpaceRow {
  id: string;
  name: string;
}

export interface SpaceSummaryRow extends SpaceRow {
  conversation_count: number;
  message_count: number;
  last_sent_at: string | null;
}

export interface AgentNameRow {
  id: string;
  display_name: string;
}

export interface ConversationRow {
  id: string;
  space_id: string;
  title: string;
}

export interface MessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  space_id: string;
  sender_kind: string;
  sender_agent_id: string | null;
  body: string;
  sent_at: string;
}

export interface EventRow {
  seq: number;
  id: string;
  agent_id: string;
  kind: string;
  space_id: string;
  created_at: string;
}

export interface AttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface EscalationRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  reason: string;
  created_at: string;
  notification_state: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
}

export interface ReadLogRow {
  /** The table's implicit rowid, selected explicitly: it is half the cursor. */
  row_id: number;
  id: string;
  agent_id: string;
  read_at: string;
  kind: string;
  params_json: string;
  cursor: string;
  item_count: number;
  /** How many reads this row stands for; 1 unless a sweep compacted a run. */
  collapsed_count: number;
  /** When the run this row stands for began. Null when it stands only for itself. */
  first_read_at: string | null;
}

/** A candidate for collapse, with what the chain rule needs to walk it. */
export interface EmptyStreamReadRow {
  row_id: number;
  agent_id: string;
  read_at: string;
  params_json: string;
  cursor: string;
  collapsed_count: number;
  first_read_at: string | null;
}

/** Everything the read-log statements bind apart from the agent. */
export interface ReadLogBounds {
  since: string | null;
  until: string | null;
  afterAt: string | null;
  /** Only read when `afterAt` is not null, but a named parameter binds either way. */
  afterRow: number;
  limit: number;
}

export interface ConversationSummaryRow extends ConversationRow {
  /** Null for a thread the human opened. */
  opened_by_agent_id: string | null;
  opener_name: string | null;
  message_count: number;
  last_sent_at: string | null;
  last_sender_kind: string | null;
  last_sender_agent_id: string | null;
  last_sender_name: string | null;
}

export interface StreamRow {
  seq: number;
  kind: string;
}

/** Everything the search statements bind. `afterRank` is read only in relevance order. */
export interface SearchBounds {
  query: string;
  space: string | null;
  afterSeq: number | null;
  afterRank: number;
  limit: number;
}

export type SearchRow = MessageRow & { snippet: string; rank: number };

const SEARCH_COLUMNS =
  'SELECT m.*, message_fts.rank AS rank, ' +
  `       snippet(message_fts, 0, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 24) AS snippet ` +
  '  FROM message_fts JOIN message m ON m.seq = message_fts.rowid ' +
  ' WHERE message_fts MATCH @query AND (@space IS NULL OR m.space_id = @space) ';

/** Everything the escalation list statements bind. */
export interface EscalationBounds {
  state: string | null;
  dueAt: string | null;
  afterAt: string | null;
  /** Only read when `afterAt` is not null, but a named parameter binds either way. */
  afterId: string;
  limit: number;
}

const ESCALATION_COLUMNS =
  'SELECT * FROM escalation WHERE (@state IS NULL OR notification_state = @state) ' +
  '   AND (@dueAt IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= @dueAt) ';

const READ_LOG_COLUMNS =
  'SELECT rowid AS row_id, id, agent_id, read_at, kind, params_json, cursor, item_count, ' +
  '       collapsed_count, first_read_at ' +
  '  FROM read_log WHERE ';

/**
 * The range, the keyset cursor and the ordering, shared by both read-log
 * statements. `read_at` is not unique, so the rowid breaks the tie and both
 * halves travel in the cursor; without that, a page taken across reads
 * recorded in the same millisecond either repeats rows or skips them.
 */
const READ_LOG_TAIL =
  '   AND (@since IS NULL OR read_at >= @since) ' +
  '   AND (@until IS NULL OR read_at < @until) ' +
  '   AND (@afterAt IS NULL OR read_at < @afterAt ' +
  '        OR (read_at = @afterAt AND rowid < @afterRow)) ' +
  ' ORDER BY read_at DESC, rowid DESC LIMIT @limit';

export function prepareStatements(db: Db) {
  // The library's conditional `Statement` type is not assignable to `Prepared`
  // for a still-generic `P`, though every instantiation is; the cast is the
  // one place the two meet.
  const prepare = <P extends object | [], R>(sql: string): Prepared<P, R> =>
    db.prepare<P, R>(sql) as unknown as Prepared<P, R>;

  return {
    nextSeq: prepare<[], { next: number }>(
      "UPDATE sequence SET next = next + 1 WHERE name = 'stream' RETURNING next",
    ),
    tip: prepare<[], { next: number }>("SELECT next FROM sequence WHERE name = 'stream'"),

    insertAgent: prepare<{ id: string; name: string; at: string }, unknown>(
      'INSERT INTO agent (id, display_name, created_at) VALUES (@id, @name, @at)',
    ),
    getAgent: prepare<{ id: string }, AgentRow>('SELECT * FROM agent WHERE id = @id'),
    renameAgent: prepare<{ id: string; name: string }, unknown>(
      'UPDATE agent SET display_name = @name WHERE id = @id',
    ),
    insertLabelHistory: prepare<
      { kind: string; subject: string; label: string; until: string },
      unknown
    >(
      'INSERT INTO label_history (kind, subject_id, label, until) ' +
        'VALUES (@kind, @subject, @label, @until)',
    ),
    // The label in force when history stood at @labelSeq: the earliest rename
    // after that point holds it. None means the current label was in force.
    labelAsOf: prepare<{ kind: string; subject: string; labelSeq: number }, { label: string }>(
      'SELECT label FROM label_history WHERE kind = @kind AND subject_id = @subject ' +
        'AND seq > @labelSeq ORDER BY seq ASC LIMIT 1',
    ),
    readLabelSeq: prepare<{ id: string }, { label_seq: number; read_at: string; tip_seq: number }>(
      'SELECT label_seq, read_at, tip_seq FROM read_log WHERE id = @id',
    ),
    setArchived: prepare<{ id: string; archived: number }, unknown>(
      'UPDATE agent SET archived = @archived WHERE id = @id',
    ),
    listAgents: prepare<{ includeArchived: number }, AgentRow>(
      'SELECT * FROM agent WHERE (@includeArchived = 1 OR archived = 0) ORDER BY display_name',
    ),
    touchAgent: prepare<{ id: string; at: string }, unknown>(
      'UPDATE agent SET last_seen_at = @at WHERE id = @id',
    ),
    countFailedAuth: prepare<{ id: string }, unknown>(
      'UPDATE agent SET failed_auth_attempts = failed_auth_attempts + 1 WHERE id = @id',
    ),

    insertKey: prepare<
      { id: string; agent: string; hash: string; label: string | null; at: string },
      unknown
    >(
      'INSERT INTO api_key (id, agent_id, key_hash, label, created_at) ' +
        'VALUES (@id, @agent, @hash, @label, @at)',
    ),
    keyByHash: prepare<
      { hash: string },
      { id: string; agent_id: string; key_hash: string; revoked_at: string | null }
    >('SELECT id, agent_id, key_hash, revoked_at FROM api_key WHERE key_hash = @hash'),
    revokeKey: prepare<{ id: string; at: string }, unknown>(
      'UPDATE api_key SET revoked_at = @at WHERE id = @id AND revoked_at IS NULL',
    ),
    revokeAgentKeys: prepare<{ agent: string; at: string }, unknown>(
      'UPDATE api_key SET revoked_at = @at WHERE agent_id = @agent AND revoked_at IS NULL',
    ),
    listKeys: prepare<
      { agent: string },
      {
        id: string;
        agent_id: string;
        label: string | null;
        created_at: string;
        revoked_at: string | null;
      }
    >(
      'SELECT id, agent_id, label, created_at, revoked_at FROM api_key ' +
        'WHERE agent_id = @agent ORDER BY created_at, id',
    ),

    insertSpace: prepare<{ id: string; name: string; at: string }, unknown>(
      'INSERT INTO space (id, name, created_at) VALUES (@id, @name, @at)',
    ),
    getSpace: prepare<{ id: string }, SpaceRow>('SELECT id, name FROM space WHERE id = @id'),
    renameSpace: prepare<{ id: string; name: string }, unknown>(
      'UPDATE space SET name = @name WHERE id = @id',
    ),
    listSpaces: prepare<[], SpaceRow>('SELECT id, name FROM space ORDER BY name'),
    // Three correlated counts rather than one join-and-group: a space with no
    // threads still needs a row, and a join through conversation to message
    // would multiply nothing into nothing.
    spaceSummaries: prepare<[], SpaceSummaryRow>(
      'SELECT s.id AS id, s.name AS name, ' +
        '       (SELECT COUNT(*) FROM conversation c WHERE c.space_id = s.id) AS conversation_count, ' +
        '       (SELECT COUNT(*) FROM message m JOIN conversation c ON c.id = m.conversation_id ' +
        '         WHERE c.space_id = s.id) AS message_count, ' +
        '       (SELECT MAX(m.sent_at) FROM message m JOIN conversation c ON c.id = m.conversation_id ' +
        '         WHERE c.space_id = s.id) AS last_sent_at ' +
        '  FROM space s ORDER BY s.name',
    ),

    openMembership: prepare<{ agent: string; space: string }, { id: string }>(
      'SELECT id FROM membership WHERE agent_id = @agent AND space_id = @space AND revoked_seq IS NULL',
    ),
    insertMembership: prepare<
      { id: string; agent: string; space: string; at: string; seq: number },
      unknown
    >(
      'INSERT INTO membership (id, agent_id, space_id, granted_at, granted_seq) ' +
        'VALUES (@id, @agent, @space, @at, @seq)',
    ),
    closeMembership: prepare<{ id: string; at: string; seq: number }, unknown>(
      'UPDATE membership SET revoked_at = @at, revoked_seq = @seq WHERE id = @id',
    ),
    spacesForAgent: prepare<{ agent: string }, SpaceRow>(
      'SELECT s.id, s.name FROM space s JOIN membership m ON m.space_id = s.id ' +
        'WHERE m.agent_id = @agent AND m.revoked_seq IS NULL ORDER BY s.name',
    ),
    membershipIntervals: prepare<
      { agent: string | null; space: string | null },
      {
        id: string;
        agent_id: string;
        space_id: string;
        granted_at: string;
        revoked_at: string | null;
      }
    >(
      'SELECT id, agent_id, space_id, granted_at, revoked_at FROM membership ' +
        'WHERE (@agent IS NULL OR agent_id = @agent) AND (@space IS NULL OR space_id = @space) ' +
        'ORDER BY granted_seq',
    ),
    // Includes the caller: a roster that omits you is not a roster.
    peers: prepare<{ agent: string; space: string | null }, AgentNameRow>(
      'SELECT DISTINCT a.id, a.display_name FROM agent a ' +
        'JOIN membership m ON m.agent_id = a.id AND m.revoked_seq IS NULL ' +
        'WHERE a.archived = 0 AND m.space_id IN (' +
        '  SELECT space_id FROM membership WHERE agent_id = @agent AND revoked_seq IS NULL' +
        '    AND (@space IS NULL OR space_id = @space)' +
        ') ORDER BY a.display_name',
    ),
    resolveMentionName: prepare<{ space: string; name: string }, { id: string }>(
      'SELECT a.id FROM agent a JOIN membership m ON m.agent_id = a.id AND m.revoked_seq IS NULL ' +
        'WHERE m.space_id = @space AND a.display_name = @name AND a.archived = 0',
    ),
    // Ever a member, not currently: a message that named someone keeps naming
    // them after they leave. Scoping to the space at all is what stops a
    // hand-written token probing for a stranger's name.
    resolveMentionRef: prepare<{ space: string; agent: string }, { display_name: string }>(
      'SELECT a.display_name FROM agent a WHERE a.id = @agent AND EXISTS (' +
        '  SELECT 1 FROM membership m WHERE m.agent_id = a.id AND m.space_id = @space)',
    ),

    insertConversation: prepare<
      { id: string; space: string; title: string; at: string; by: string | null },
      unknown
    >(
      'INSERT INTO conversation (id, space_id, title, created_at, created_by_agent_id) ' +
        'VALUES (@id, @space, @title, @at, @by) ON CONFLICT (space_id, title) DO NOTHING',
    ),
    conversationByTitle: prepare<{ space: string; title: string }, ConversationRow>(
      'SELECT id, space_id, title FROM conversation WHERE space_id = @space AND title = @title',
    ),
    getConversation: prepare<{ id: string }, ConversationRow>(
      'SELECT id, space_id, title FROM conversation WHERE id = @id',
    ),
    renameConversation: prepare<{ id: string; title: string }, unknown>(
      'UPDATE conversation SET title = @title WHERE id = @id',
    ),
    insertMessage: prepare<
      {
        seq: number;
        id: string;
        conversation: string;
        space: string;
        senderKind: string;
        senderAgent: string | null;
        body: string;
        at: string;
      },
      unknown
    >(
      'INSERT INTO message (seq, id, conversation_id, space_id, sender_kind, sender_agent_id, body, sent_at) ' +
        'VALUES (@seq, @id, @conversation, @space, @senderKind, @senderAgent, @body, @at)',
    ),
    messageBySeq: prepare<{ seq: number }, MessageRow>('SELECT * FROM message WHERE seq = @seq'),
    messageById: prepare<{ id: string }, MessageRow>('SELECT * FROM message WHERE id = @id'),
    insertAttachment: prepare<
      {
        id: string;
        message: string;
        filename: string;
        contentType: string;
        size: number;
        at: string;
      },
      unknown
    >(
      'INSERT INTO attachment (id, message_id, filename, content_type, size_bytes, created_at) ' +
        'VALUES (@id, @message, @filename, @contentType, @size, @at)',
    ),
    attachmentsFor: prepare<{ message: string }, AttachmentRow>(
      'SELECT id, filename, content_type, size_bytes FROM attachment ' +
        'WHERE message_id = @message ORDER BY created_at, id',
    ),
    getAttachment: prepare<
      { id: string },
      AttachmentRow & { message_id: string; space_id: string }
    >(
      'SELECT a.id, a.filename, a.content_type, a.size_bytes, a.message_id, m.space_id ' +
        'FROM attachment a JOIN message m ON m.id = a.message_id WHERE a.id = @id',
    ),

    insertEvent: prepare<
      { seq: number; id: string; agent: string; kind: string; space: string; at: string },
      unknown
    >(
      'INSERT INTO system_event (seq, id, agent_id, kind, space_id, created_at) ' +
        'VALUES (@seq, @id, @agent, @kind, @space, @at)',
    ),
    eventBySeq: prepare<{ seq: number }, EventRow>('SELECT * FROM system_event WHERE seq = @seq'),

    // The whole access rule, in one place.
    //
    // A message is delivered when the agent can see its space *now* AND the
    // message fell inside one of that agent's membership intervals when it was
    // written. Both are needed: the first hides a revoked space's backlog, the
    // second stops a new grant replaying history (ADR-0009).
    //
    // System events carry no access test at all — a revocation must deliver
    // the event announcing it.
    streamPage: prepare<{ agent: string; after: number; tip: number; limit: number }, StreamRow>(
      'SELECT seq, kind FROM (' +
        "  SELECT m.seq AS seq, 'message' AS kind FROM message m" +
        '   WHERE m.seq > @after AND m.seq <= @tip' +
        '     AND EXISTS (SELECT 1 FROM membership cur WHERE cur.agent_id = @agent' +
        '                   AND cur.space_id = m.space_id AND cur.revoked_seq IS NULL)' +
        '     AND EXISTS (SELECT 1 FROM membership win WHERE win.agent_id = @agent' +
        '                   AND win.space_id = m.space_id AND m.seq > win.granted_seq' +
        '                   AND (win.revoked_seq IS NULL OR m.seq < win.revoked_seq))' +
        '  UNION ALL' +
        "  SELECT e.seq AS seq, 'event' AS kind FROM system_event e" +
        '   WHERE e.seq > @after AND e.seq <= @tip AND e.agent_id = @agent' +
        ') ORDER BY seq LIMIT @limit',
    ),
    streamAnchorBefore: prepare<{ since: string }, { seq: number | null }>(
      'SELECT MAX(seq) AS seq FROM (' +
        '  SELECT seq FROM message WHERE sent_at < @since' +
        '  UNION ALL' +
        '  SELECT seq FROM system_event WHERE created_at < @since' +
        ')',
    ),

    // Two statements per source rather than one with a conditional ORDER BY:
    // the direction has to be visible to the query planner, or the index on
    // (conversation_id, seq) stops being an ordering and becomes a sort.
    // `@after` is the exclusive bound in the direction of travel — a floor
    // going forwards, a ceiling going backwards. `@ceiling` is the other kind
    // of ceiling: an inclusive one on the sequence itself, set only by the
    // as-of view, where the bound is a stream position rather than a request.
    conversationPage: prepare<
      {
        conversation: string;
        after: number;
        ceiling: number | null;
        since: string | null;
        until: string | null;
        limit: number;
      },
      MessageRow
    >(
      'SELECT * FROM message WHERE conversation_id = @conversation AND seq > @after ' +
        'AND (@ceiling IS NULL OR seq <= @ceiling) ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq LIMIT @limit',
    ),
    conversationPageBackwards: prepare<
      {
        conversation: string;
        after: number;
        ceiling: number | null;
        since: string | null;
        until: string | null;
        limit: number;
      },
      MessageRow
    >(
      'SELECT * FROM message WHERE conversation_id = @conversation AND seq < @after ' +
        'AND (@ceiling IS NULL OR seq <= @ceiling) ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq DESC LIMIT @limit',
    ),
    spacePage: prepare<
      { space: string; after: number; since: string | null; until: string | null; limit: number },
      MessageRow
    >(
      'SELECT * FROM message WHERE space_id = @space AND seq > @after ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq LIMIT @limit',
    ),
    spacePageBackwards: prepare<
      { space: string; after: number; since: string | null; until: string | null; limit: number },
      MessageRow
    >(
      'SELECT * FROM message WHERE space_id = @space AND seq < @after ' +
        'AND (@since IS NULL OR sent_at >= @since) AND (@until IS NULL OR sent_at < @until) ' +
        'ORDER BY seq DESC LIMIT @limit',
    ),

    // One grouped query for the whole thread list.
    //
    // The bare columns beside MAX(m.seq) are the values from the row that
    // produced the maximum — SQLite defines that for a query with exactly one
    // min/max aggregate, and it is why this needs no correlated subquery per
    // conversation. LEFT JOIN, so a thread nobody has posted to still appears.
    //
    // Ordered by last activity, which is what a thread list is for; NULL sorts
    // last under DESC, so empty threads fall to the bottom.
    conversationSummaries: prepare<{ space: string }, ConversationSummaryRow>(
      'SELECT c.id AS id, c.space_id AS space_id, c.title AS title, ' +
        '       c.created_by_agent_id AS opened_by_agent_id, opener.display_name AS opener_name, ' +
        '       COUNT(m.seq) AS message_count, MAX(m.seq) AS last_seq, ' +
        '       m.sent_at AS last_sent_at, m.sender_kind AS last_sender_kind, ' +
        '       m.sender_agent_id AS last_sender_agent_id, a.display_name AS last_sender_name ' +
        '  FROM conversation c ' +
        '  LEFT JOIN agent opener ON opener.id = c.created_by_agent_id ' +
        '  LEFT JOIN message m ON m.conversation_id = c.id ' +
        '  LEFT JOIN agent a ON a.id = m.sender_agent_id ' +
        ' WHERE c.space_id = @space ' +
        ' GROUP BY c.id ' +
        ' ORDER BY last_seq DESC, c.created_at DESC, c.id',
    ),
    // Relevance is bm25 `rank` (lower is better), with seq breaking ties so
    // the order is total and a keyset cursor can continue it. FTS5 allows
    // `rank` in WHERE, which is what makes the continuation a single query.
    searchByRank: prepare<SearchBounds, SearchRow>(
      SEARCH_COLUMNS +
        '   AND (@afterSeq IS NULL OR rank > @afterRank ' +
        '        OR (rank = @afterRank AND m.seq < @afterSeq)) ' +
        ' ORDER BY rank, m.seq DESC LIMIT @limit',
    ),
    searchNewest: prepare<SearchBounds, SearchRow>(
      SEARCH_COLUMNS +
        '   AND (@afterSeq IS NULL OR m.seq < @afterSeq) ' +
        ' ORDER BY m.seq DESC LIMIT @limit',
    ),

    getIdempotency: prepare<
      { writer: string; key: string },
      { request_hash: string; outcome_json: string }
    >('SELECT request_hash, outcome_json FROM idempotency WHERE writer = @writer AND key = @key'),
    putIdempotency: prepare<
      { writer: string; key: string; hash: string; outcome: string; at: string },
      unknown
    >(
      'INSERT INTO idempotency (writer, key, request_hash, outcome_json, created_at) ' +
        'VALUES (@writer, @key, @hash, @outcome, @at)',
    ),

    insertRead: prepare<
      {
        id: string;
        agent: string;
        at: string;
        kind: string;
        params: string;
        cursor: string;
        count: number;
      },
      unknown
    >(
      // `label_seq` is taken inside the read's own transaction, so it is the
      // history position the rendering actually used; `tip_seq` likewise, so
      // it is the stream position the read served — or could have served, for
      // a read of one thread or one file. Every kind gets it: the tip is a
      // global position, and what a read could have seen is everything at or
      // below it.
      'INSERT INTO read_log (id, agent_id, read_at, kind, params_json, cursor, item_count, ' +
        '                      label_seq, tip_seq) ' +
        'VALUES (@id, @agent, @at, @kind, @params, @cursor, @count, ' +
        '        (SELECT COALESCE(MAX(seq), 0) FROM label_history), ' +
        "        (SELECT next FROM sequence WHERE name = 'stream'))",
    ),
    // Keyset paging, not OFFSET: the log only grows, and a page taken by
    // offset while it grows either repeats rows or skips them — in the one
    // view whose whole job is completeness.
    //
    // Two statements rather than one with `@agent IS NULL OR agent_id =
    // @agent`, because a plan is chosen when a statement is prepared and not
    // when it is bound: that disjunction cannot use the composite index, so
    // asking for one agent's reads would walk the whole log filtering as it
    // went. Named separately, each gets the index that answers it.
    listReads: prepare<ReadLogBounds, ReadLogRow>(READ_LOG_COLUMNS + '1 = 1' + READ_LOG_TAIL),
    readLogById: prepare<{ id: string }, ReadLogRow>(READ_LOG_COLUMNS + 'id = @id'),
    listReadsForAgent: prepare<ReadLogBounds & { agent: string }, ReadLogRow>(
      READ_LOG_COLUMNS + 'agent_id = @agent' + READ_LOG_TAIL,
    ),
    // Every empty stream read old enough to compact, in the order the chain
    // rule walks them: per agent, and within an agent by rowid, which is the
    // order they were written in. An already-collapsed row is an ordinary
    // candidate, which is what makes repeated sweeps converge on one row per
    // idle stretch rather than one per sweep.
    emptyStreamReads: prepare<{ before: string }, EmptyStreamReadRow>(
      'SELECT rowid AS row_id, agent_id, read_at, params_json, cursor, collapsed_count, ' +
        '       first_read_at ' +
        "  FROM read_log WHERE kind = 'stream' AND item_count = 0 AND read_at < @before " +
        ' ORDER BY agent_id, rowid',
    ),
    collapseRead: prepare<{ row: number; count: number; first: string }, unknown>(
      'UPDATE read_log SET collapsed_count = @count, first_read_at = @first WHERE rowid = @row',
    ),
    deleteReadRow: prepare<{ row: number }, unknown>('DELETE FROM read_log WHERE rowid = @row'),
    lastStreamRead: prepare<{ agent: string }, { cursor: string }>(
      "SELECT cursor FROM read_log WHERE agent_id = @agent AND kind = 'stream' " +
        'ORDER BY read_at DESC, rowid DESC LIMIT 1',
    ),

    insertEscalation: prepare<
      { id: string; agent: string; conversation: string; reason: string; at: string },
      unknown
    >(
      'INSERT INTO escalation (id, agent_id, conversation_id, reason, created_at, notification_state) ' +
        "VALUES (@id, @agent, @conversation, @reason, @at, 'pending')",
    ),
    getEscalation: prepare<{ id: string }, EscalationRow>(
      'SELECT * FROM escalation WHERE id = @id',
    ),
    // Keyset over (created_at, id) in either direction, like the read log; the
    // notifier walks oldest-first, the inbox newest-first.
    escalationsOldest: prepare<EscalationBounds, EscalationRow>(
      ESCALATION_COLUMNS +
        '   AND (@afterAt IS NULL OR created_at > @afterAt ' +
        '        OR (created_at = @afterAt AND id > @afterId)) ' +
        ' ORDER BY created_at, id LIMIT @limit',
    ),
    escalationsNewest: prepare<EscalationBounds, EscalationRow>(
      ESCALATION_COLUMNS +
        '   AND (@afterAt IS NULL OR created_at < @afterAt ' +
        '        OR (created_at = @afterAt AND id < @afterId)) ' +
        ' ORDER BY created_at DESC, id DESC LIMIT @limit',
    ),
    countUndelivered: prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM escalation WHERE notification_state != 'sent'",
    ),
    markEscalation: prepare<
      {
        id: string;
        state: string;
        at: string;
        error: string | null;
        next: string | null;
      },
      unknown
    >(
      'UPDATE escalation SET notification_state = @state, attempts = attempts + 1, ' +
        'last_attempt_at = @at, last_error = @error, next_attempt_at = @next WHERE id = @id',
    ),

    insertSession: prepare<{ id: string; hash: string; at: string; expires: string }, unknown>(
      'INSERT INTO session (id, token_hash, created_at, expires_at) ' +
        'VALUES (@id, @hash, @at, @expires)',
    ),
    sessionByHash: prepare<
      { hash: string },
      { id: string; created_at: string; expires_at: string }
    >('SELECT id, created_at, expires_at FROM session WHERE token_hash = @hash'),
    deleteSession: prepare<{ hash: string }, unknown>(
      'DELETE FROM session WHERE token_hash = @hash',
    ),
    deleteExpiredSessions: prepare<{ at: string }, unknown>(
      'DELETE FROM session WHERE expires_at <= @at',
    ),
    deleteAllSessions: prepare<[], unknown>('DELETE FROM session'),

    getMeta: prepare<{ key: string }, { value: string }>('SELECT value FROM meta WHERE key = @key'),
    setMeta: prepare<{ key: string; value: string }, unknown>(
      'INSERT INTO meta (key, value) VALUES (@key, @value) ' +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ),
  };
}

export type Statements = ReturnType<typeof prepareStatements>;
