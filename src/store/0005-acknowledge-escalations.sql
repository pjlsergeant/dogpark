-- Dogpark schema, migration 0005.
--
-- Applied by src/store/migrate.ts after 0004. Forward-only: frozen once it has
-- run anywhere; later changes are separate migrations. ADD COLUMN is safe on a
-- STRICT table — strictness is a property of the table, not of how it was
-- built.

-- ---------------------------------------------------------------------------
-- Acknowledging an escalation
-- ---------------------------------------------------------------------------

-- An escalation is the product's page-a-human channel, but until now one could
-- never be marked handled: the inbox badge counted every escalation that was
-- never delivered, forever, so in the blessed no-webhook deployment it only
-- ever climbed. A nullable `acknowledged_at` settles one — null is
-- unacknowledged and the badge's business, a timestamp means a person has
-- seen it. Delivery state is a separate axis, demoted to per-row detail.
ALTER TABLE escalation ADD COLUMN acknowledged_at TEXT;

CREATE INDEX escalation_acknowledged_at ON escalation (acknowledged_at);
