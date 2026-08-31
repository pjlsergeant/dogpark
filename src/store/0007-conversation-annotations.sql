-- Dogpark schema, migration 0007. Forward-only and frozen once applied.

-- Append-only conversation state. `seq` is allocated from the same sequence as
-- messages and membership events, so a read-log tip reconstructs annotations
-- without timestamps or mutable snapshots. Same-conversation pin targets are
-- enforced in code: SQLite cannot express that cross-row constraint here.
CREATE TABLE conversation_annotation (
  seq INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation (id),
  kind TEXT NOT NULL CHECK (kind IN ('completed', 'reopened', 'pinned', 'unpinned')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human')),
  actor_agent_id TEXT REFERENCES agent (id),
  message_id TEXT REFERENCES message (id),
  created_at TEXT NOT NULL,
  CHECK ((actor_kind = 'agent') = (actor_agent_id IS NOT NULL)),
  CHECK ((kind = 'pinned') = (message_id IS NOT NULL))
) STRICT;

CREATE INDEX conversation_annotation_conversation
  ON conversation_annotation (conversation_id, seq);
