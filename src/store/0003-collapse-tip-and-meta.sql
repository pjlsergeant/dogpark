-- Dogpark schema, migration 0003.
--
-- Applied by src/store/migrate.ts after 0002. Forward-only: frozen once it has
-- run anywhere; later changes are separate migrations. ADD COLUMN is safe on a
-- STRICT table — strictness is a property of the table, not of how it was
-- built.

-- ---------------------------------------------------------------------------
-- The stream tip at the read
-- ---------------------------------------------------------------------------

-- `tip_seq` is the last sequence allocated when the read ran, taken inside the
-- read's own transaction: for any kind of read, a message existed at that
-- moment iff its seq is at or below it. It is what makes "the thread as it read
-- on this row" an exact cutoff rather than a timestamp comparison, which cannot
-- separate a read from a message written in the same millisecond. Rows from
-- before this migration get 0, meaning unknown — those keep the old, coarse
-- bound.
ALTER TABLE read_log ADD COLUMN tip_seq INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Compacted empty polls
-- ---------------------------------------------------------------------------

-- An idle agent long-polling writes thousands of empty stream rows a day. A run
-- of consecutive empty stream reads that each resumed where the last left off
-- collapses into its last row, which is a real read and keeps its own id,
-- cursor and parameters; these two columns say that it also stands for the ones
-- before it. `collapsed_count` is how many reads the row represents — 1 for an
-- ordinary row — and `first_read_at` is when the run began, null when the row
-- stands only for itself. Nothing that returned content is ever compacted, so
-- the compaction is a visible summary and not a deletion.
ALTER TABLE read_log ADD COLUMN collapsed_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE read_log ADD COLUMN first_read_at TEXT;

-- ---------------------------------------------------------------------------
-- Meta
-- ---------------------------------------------------------------------------

-- Small key/value state about the deployment rather than about its domain, so
-- it needs no table of its own each time. First use: `password-fingerprint`, a
-- hash of the configured password hash, which is how a rotation is noticed at
-- startup — a hash of the verifier, so this table never holds the verifier.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
