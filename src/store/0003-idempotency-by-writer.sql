-- Dogpark schema, migration 0003: idempotency keyed by writer, not by agent.
--
-- The table was keyed `(agent_id, key)` with a foreign key into `agent`, so
-- the human — who is not an agent and has no row — could not have an
-- idempotency key at all. `postMessage` refused one outright, and the HTTP
-- layer kept a parallel in-memory map to collapse a double-click, which lost
-- every key on restart and stored rendered results the store deliberately
-- does not (ADR-0014).
--
-- `writer` holds an agent id or the literal `:human`. The two cannot collide,
-- and not merely because ids are sixteen characters long: `:` is outside the
-- id alphabet entirely, so no id — including one a hand-written row put in the
-- agent table, which this schema does not constrain — can ever equal it.
--
-- The foreign key goes with the rename, because the human has nothing to
-- reference. Nothing deletes an agent (archiving is not retirement, ADR-0013),
-- so no row is orphaned by losing it.
CREATE TABLE idempotency_by_writer (
  writer TEXT NOT NULL,
  key TEXT NOT NULL,
  -- Replaying a key with a different request is an error, not a silent replay
  -- of the old answer.
  request_hash TEXT NOT NULL,
  -- Identifiers only, never a rendered result: labels are rendered on read, so
  -- a replay must re-render rather than return a frozen title (ADR-0014).
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (writer, key)
) STRICT;

INSERT INTO idempotency_by_writer (writer, key, request_hash, outcome_json, created_at)
SELECT agent_id, key, request_hash, outcome_json, created_at FROM idempotency;

DROP TABLE idempotency;
ALTER TABLE idempotency_by_writer RENAME TO idempotency;
