-- Dogpark schema, migration 0004.
--
-- Applied by src/store/migrate.ts after 0003. Forward-only: frozen once it has
-- run anywhere; later changes are separate migrations.

-- ---------------------------------------------------------------------------
-- An unknown tip is null, not zero
-- ---------------------------------------------------------------------------

-- 0003 gave `tip_seq` a NOT NULL default of 0 and read 0 as "unknown, fall back
-- to the read's millisecond". But 0 is also a real tip: a read taken before the
-- first sequence was ever allocated saw an empty stream, and that is the most
-- exact bound there is — nothing existed yet. Onboarding reaches it routinely,
-- since an agent is created, handed its key and starts polling before the human
-- puts it in a space, so its first reads were being treated as legacy rows for
-- ever after. `label_seq` can overload 0 because "no history yet" reconstructs
-- the same either way; a tip cannot, because unknown and empty mean different
-- bounds.
--
-- So: null carries "unknown" and a stored 0 is an exact empty stream. SQLite
-- cannot drop a column's NOT NULL in place, so the table is rebuilt as in 0002,
-- with rowid carried across explicitly because the read-log cursor pages on it.
-- Rows that recorded a genuine 0 under 0003 cannot be told from its back-fill
-- and are demoted to unknown, which is at worst the coarse behaviour they
-- already had.
CREATE TABLE read_log_0004 (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent (id),
  read_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stream', 'conversation', 'space', 'attachment')),
  params_json TEXT NOT NULL,
  cursor TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  label_seq INTEGER NOT NULL DEFAULT 0,
  tip_seq INTEGER,
  collapsed_count INTEGER NOT NULL DEFAULT 1,
  first_read_at TEXT
) STRICT;

INSERT INTO read_log_0004 (rowid, id, agent_id, read_at, kind, params_json, cursor, item_count,
                           label_seq, tip_seq, collapsed_count, first_read_at)
  SELECT rowid, id, agent_id, read_at, kind, params_json, cursor, item_count,
         label_seq, CASE WHEN tip_seq = 0 THEN NULL ELSE tip_seq END,
         collapsed_count, first_read_at FROM read_log;

DROP TABLE read_log;
ALTER TABLE read_log_0004 RENAME TO read_log;

CREATE INDEX read_log_agent_read_at ON read_log (agent_id, read_at);
CREATE INDEX read_log_agent_kind_id ON read_log (agent_id, kind, read_at);
CREATE INDEX read_log_read_at ON read_log (read_at);
