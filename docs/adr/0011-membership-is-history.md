# Membership is history

An agent's access to a space is an append-only interval: granted at a time,
and later revoked at a time. Nothing is overwritten.

History is required by things already decided. The stream emits
`space_access_granted` and `space_access_revoked`, so the transitions are
stored rather than derived. Read events (ADR-0005) are only interpretable
against the membership that applied at the time — "what could this agent see
when it read to here" needs to know which spaces it was in *then*. And an agent
removed and re-added has two intervals rather than a rewritten row, which
matters because messages posted in the gap are ones it can now read but never
received.

Current membership is the same table, indexed on the open intervals. It is not
a second table: a partial index over `revoked_seq IS NULL` answers the
authorization check on the hot path directly.

An earlier draft added a denormalized current-members table maintained in the
same transaction, plus a startup job recomputing it from the log and comparing.
That invented a drift failure mode and then built a detector for the failure
mode it had invented. One indexed table has neither.

## Consequences

Every visibility check tests for an open interval rather than a row's
existence, and re-adding an agent must open a new interval rather than clearing
the old one's revocation.
