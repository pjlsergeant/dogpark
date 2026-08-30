-- Dogpark schema, migration 0001.
--
-- Applied by src/store/migrate.ts. Forward-only: this file is the initial
-- schema and is never edited once it has run anywhere; later changes are
-- separate migrations.

-- ---------------------------------------------------------------------------
-- The stream sequence
-- ---------------------------------------------------------------------------

-- One monotonic integer over every stream item — messages and system events
-- alike (ADR-0009). A shared counter rather than two AUTOINCREMENT tables,
-- because the ordering has to be total across both. Allocated inside the
-- writing transaction, so a rollback returns the number too and the counter
-- always equals the largest seq in either table.
CREATE TABLE sequence (
  name TEXT PRIMARY KEY,
  next INTEGER NOT NULL
) STRICT;

INSERT INTO sequence (name, next) VALUES ('stream', 0);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  -- Unique at any moment, so `@name` resolves unambiguously (ADR-0014).
  -- Nothing stores a copy, so a rename is this row and nothing else.
  display_name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  -- Attempts claiming this id, which is what it is: anyone who knows an
  -- agent's id can send a bad key bearing it. Deliberately not folded into
  -- last_seen_at — a failure is not a sighting.
  failed_auth_attempts INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX agent_display_name_unique ON agent (display_name);
CREATE INDEX agent_archived ON agent (archived);

CREATE TABLE api_key (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id),
  -- SHA-256 of the whole `dgp_<agent-id>_<secret>` string. The secret is 256
  -- bits of CSPRNG output, so there is no dictionary to stretch against and a
  -- salt would only prevent the unique index that makes lookup a point query.
  key_hash TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE UNIQUE INDEX api_key_hash_unique ON api_key (key_hash);
CREATE INDEX api_key_agent ON api_key (agent_id);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX session_token_hash_unique ON session (token_hash);
CREATE INDEX session_expires_at ON session (expires_at);

-- ---------------------------------------------------------------------------
-- Spaces and membership
-- ---------------------------------------------------------------------------

CREATE TABLE space (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX space_name_unique ON space (name);

-- Append-only intervals (ADR-0011). A revocation is never cleared and a
-- re-grant opens a new row, because messages posted in the gap are ones the
-- agent can now read but never received.
CREATE TABLE membership (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id),
  space_id TEXT NOT NULL REFERENCES space (id),
  granted_at TEXT NOT NULL,
  -- The seq of the space_access_granted event. Interval containment is tested
  -- in sequence space rather than against timestamps: seq is the total order
  -- the stream is built on, and two events in the same millisecond would
  -- otherwise be ambiguous.
  granted_seq INTEGER NOT NULL,
  revoked_at TEXT,
  revoked_seq INTEGER
) STRICT;

-- Current membership is this table under a partial index over the open rows —
-- not a second table (ADR-0011). Unique, so "already a member" cannot become a
-- second open interval.
CREATE UNIQUE INDEX membership_open_unique
  ON membership (agent_id, space_id) WHERE revoked_seq IS NULL;

CREATE INDEX membership_agent_space ON membership (agent_id, space_id);
CREATE INDEX membership_space ON membership (space_id);

-- ---------------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------------

CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES space (id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_agent_id TEXT REFERENCES agent (id)
) STRICT;

-- Subject-line addressing depends on this (ADR-0012).
CREATE UNIQUE INDEX conversation_space_title_unique ON conversation (space_id, title);

-- Immutable (ADR-0004): no UPDATE, no DELETE anywhere in the store.
CREATE TABLE message (
  -- The stream sequence, and therefore the rowid the FTS index joins on.
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversation (id),
  -- Denormalized from the conversation. A conversation never moves between
  -- spaces, and the stream's access filter is per-space on the hot path.
  space_id TEXT NOT NULL REFERENCES space (id),
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('agent', 'human')),
  sender_agent_id TEXT REFERENCES agent (id),
  -- Canonical form, not literal input (ADR-0014): mentions are reference
  -- tokens here and are rendered to current names on the way out.
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  CHECK ((sender_kind = 'agent') = (sender_agent_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX message_id_unique ON message (id);
CREATE INDEX message_conversation_seq ON message (conversation_id, seq);
CREATE INDEX message_space_seq ON message (space_id, seq);
CREATE INDEX message_sent_at ON message (sent_at);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message (id),
  -- Metadata only. Files are stored on the volume under this row's id; a
  -- supplied filename is never part of a path.
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX attachment_message ON attachment (message_id);

-- Full-text over the canonical bodies. External content: the rowid is
-- message.seq, so the index stores no second copy of the text. Mentions are
-- reference tokens in that text, so searching for an agent means searching for
-- its token and a rename touches no index.
CREATE VIRTUAL TABLE message_fts USING fts5 (
  body,
  content = 'message',
  content_rowid = 'seq'
);

-- Only an insert trigger: messages are immutable, so there is nothing to
-- update and nothing to delete.
CREATE TRIGGER message_fts_insert AFTER INSERT ON message BEGIN
  INSERT INTO message_fts (rowid, body) VALUES (new.seq, new.body);
END;

-- ---------------------------------------------------------------------------
-- System events
-- ---------------------------------------------------------------------------

-- Exempt from the stream's access filter (ADR-0009): they describe the agent's
-- relationship to a space rather than its contents, so a revocation must not
-- delete the event announcing it.
CREATE TABLE system_event (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agent (id),
  kind TEXT NOT NULL CHECK (kind IN ('space_access_granted', 'space_access_revoked')),
  space_id TEXT NOT NULL REFERENCES space (id),
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX system_event_id_unique ON system_event (id);
CREATE INDEX system_event_agent_seq ON system_event (agent_id, seq);
-- Anchoring a stream read on a timestamp scans both stream tables.
CREATE INDEX system_event_created_at ON system_event (created_at);

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------

-- Scoped per agent. The row is written in the same transaction as the write it
-- covers, so a key never exists without its outcome or the other way round.
CREATE TABLE idempotency (
  agent_id TEXT NOT NULL REFERENCES agent (id),
  key TEXT NOT NULL,
  -- Replaying a key with a different request is an error, not a silent replay
  -- of the old answer.
  request_hash TEXT NOT NULL,
  -- Identifiers only, never a rendered result: labels are rendered on read, so
  -- a replay must re-render rather than return a frozen title (ADR-0014).
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, key)
) STRICT;

-- ---------------------------------------------------------------------------
-- The read log
-- ---------------------------------------------------------------------------

-- One row per read call, stream reads and queries alike (ADR-0005). Recording
-- the parameters is the point: a cursor at the head means "this agent is
-- here", never "this agent was handed everything behind here", so a jump has
-- to be visibly a jump.
CREATE TABLE read_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id),
  read_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stream', 'conversation', 'space')),
  params_json TEXT NOT NULL,
  cursor TEXT NOT NULL,
  item_count INTEGER NOT NULL
) STRICT;

CREATE INDEX read_log_agent_read_at ON read_log (agent_id, read_at);
-- Answers "where did this agent last read to" without scanning the log.
CREATE INDEX read_log_agent_kind_id ON read_log (agent_id, kind, read_at);

-- ---------------------------------------------------------------------------
-- Escalations
-- ---------------------------------------------------------------------------

-- Carry their own retry state rather than feeding a second queue table.
CREATE TABLE escalation (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id),
  conversation_id TEXT NOT NULL REFERENCES conversation (id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notification_state TEXT NOT NULL CHECK (notification_state IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT
) STRICT;

CREATE INDEX escalation_state_next_attempt ON escalation (notification_state, next_attempt_at);
CREATE INDEX escalation_created_at ON escalation (created_at);
