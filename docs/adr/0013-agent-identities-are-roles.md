# Agent identities are roles, and are archived rather than retired

An agent in Dogpark is a role — "the thing that produces timesheets" — not a
process. The implementation behind it is expected to change: rewritten, moved,
redeployed. The identity persists, so its history stays coherent.

There is therefore no retirement and no deletion. There is **archive**, which
revokes every key and hides the agent from the active list, and **unarchive**,
which brings the role back. Unarchiving issues a *fresh* key rather than
restoring the old one, because keys are stored hashed and Dogpark genuinely
cannot re-show one — so re-implementing a role and creating one are the same
flow.

Dogpark cannot observe processes at all: it never learns that an agent stopped,
only that a credential went unused. Retirement was never an event it could
detect.

Archiving and membership are separate concerns and stay separate. Archiving
revokes credentials and hides the role; it does not touch membership, which is
history (ADR-0011). Revoking a key without archiving, or removing a role from a
space without archiving it, are both ordinary operations.

## Consequences

An unarchived role returns holding the memberships it had, because they were
never removed. After months that may no longer be right, and Dogpark will not
notice.

Nothing is ever deleted. A role that is finished stays archived, and its
threads stay readable.
