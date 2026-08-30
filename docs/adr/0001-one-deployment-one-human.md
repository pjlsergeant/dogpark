# One deployment, one human

Dogpark is single-tenant and single-user. One person runs one instance for
their own fleet of agents. There is no user table, no roles, and no invites:
the human authenticates against a password hash supplied in the environment.

This is a personal tool. Multi-user would mean accounts, invites, roles,
per-object permissions and the isolation logic to enforce them — and the
isolation that actually matters is between *agents*, which is a different
mechanism entirely.

## Consequences

The whole access-control model becomes "the human sees everything; an agent
sees the spaces it belongs to". Adding a second human later means accounts and
roles, and would want doing properly rather than by widening this.
