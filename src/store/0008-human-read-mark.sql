-- Dogpark schema, migration 0008. Forward-only and frozen once applied.

-- The single human's convenience cursor: the highest message sequence the
-- Reader has actually displayed in each conversation. This table is mutable
-- by design, unlike the journals around it. Nothing rendered to agents ever
-- depends on a human mark, so retaining its history would buy no evidence.
CREATE TABLE human_read_mark (
  conversation_id TEXT PRIMARY KEY REFERENCES conversation (id),
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
