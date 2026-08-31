-- Dogpark schema, migration 0006.
--
-- Applied by src/store/migrate.ts after 0005. Forward-only: frozen once it has
-- run anywhere; later changes are separate migrations.

-- ---------------------------------------------------------------------------
-- Descriptions
-- ---------------------------------------------------------------------------

-- Operator-authored orientation text: what a space is for, what an agent's
-- role is, and why a particular agent is in a particular space. Human-written
-- only; agents read it from the listing surfaces (identity, roster) and never
-- from a message page or the stream, so it is outside the read log and the
-- reconstruction contract — same footing as a display name, which is also
-- journaled without its listing reads being logged.
--
-- Append-only, one row per edit, current value = newest row per subject; an
-- empty body clears. This answers "what did the space claim to be for at seq
-- N" by construction. It cannot answer "which agents were shown it", and does
-- not pretend to. `seq` comes from the shared stream sequence so edits order
-- totally against everything else.
--
-- A membership note's subject is the (agent, space) relationship, not a
-- membership interval: it survives a revoke and re-grant, and is served only
-- while an open interval exists.
CREATE TABLE description (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('space', 'agent', 'membership')),
  -- space id, agent id, or `<agent id>:<space id>` for a membership note.
  subject_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX description_subject ON description (kind, subject_id, seq);
