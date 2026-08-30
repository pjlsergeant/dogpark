-- Dogpark schema, migration 0002.
--
-- Applied by src/store/migrate.ts after schema.sql. Forward-only: frozen once
-- it has run anywhere; later changes are separate migrations.

-- ---------------------------------------------------------------------------
-- Label history
-- ---------------------------------------------------------------------------

-- Labels are mutable and rendered on read (ADR-0014), so a read replayed after
-- a rename would render differently. The read log stores a reference, not a
-- copy (ADR-0005), which is only honest if every input to the rendering is
-- reconstructible: message rows are immutable (ADR-0004), membership is
-- history (ADR-0011), and this table makes labels history too. One row per
-- rename, holding the label that was in force *until* that instant; the label
-- in force at any time is the earliest row whose `until` is after it, or the
-- current label if there is none.
CREATE TABLE label_history (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'conversation')),
  subject_id TEXT NOT NULL,
  label TEXT NOT NULL,
  until TEXT NOT NULL
) STRICT;

CREATE INDEX label_history_subject ON label_history (kind, subject_id, until);

-- ---------------------------------------------------------------------------
-- Attachment reads
-- ---------------------------------------------------------------------------

-- An attachment's bytes can be as decisive as a message body, so fetching one
-- is a read and gets a row. The kind is a CHECK constraint, which SQLite
-- cannot alter in place: the table is rebuilt with the wider list. rowid is
-- carried across explicitly because the read-log cursor pages on it.
CREATE TABLE read_log_0002 (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id),
  read_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stream', 'conversation', 'space', 'attachment')),
  params_json TEXT NOT NULL,
  cursor TEXT NOT NULL,
  item_count INTEGER NOT NULL
) STRICT;

INSERT INTO read_log_0002 (rowid, id, agent_id, read_at, kind, params_json, cursor, item_count)
  SELECT rowid, id, agent_id, read_at, kind, params_json, cursor, item_count FROM read_log;

DROP TABLE read_log;
ALTER TABLE read_log_0002 RENAME TO read_log;

CREATE INDEX read_log_agent_read_at ON read_log (agent_id, read_at);
CREATE INDEX read_log_agent_kind_id ON read_log (agent_id, kind, read_at);
CREATE INDEX read_log_read_at ON read_log (read_at);
