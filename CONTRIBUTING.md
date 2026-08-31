# Contributing

`docs/architecture.md` describes the design; `docs/adr/` records why;
`CONTEXT.md` binds the two words that must not blur. This file holds the
process rules and the positions that are already settled, for humans and
reviewing agents alike.

## Review discipline

- **Every fix lands with a test shown to fail on the pre-fix code.** Stash
  the fix, run the test, watch it go red. A test that has never been seen
  red is decoration, and this project treats tests as the primary way its
  code is read.
- The ADR index (`docs/adr/README.md`) names, per decision, the test that
  fails if the decision is violated — its _arm_. A decision without one is
  labeled `no arm`, honestly. If your change arms or disarms a decision,
  update the index; a test refuses to pass if the index and the ADR files
  drift apart.
- `docs/running.md` and `docs/http-api.md` are armed the same way: a config
  variable or route that never reaches the docs fails `src/docs.test.ts`.

## Settled positions

These aren't taboo, they're pre-litigated. To reopen one, steelman it
first: state the current position's strongest case in your own words, then
say precisely where it fails. An objection that clears that bar gets
engaged on the merits; one that doesn't was already answered by the reason
its entry carries. Reviewers re-raising these get a citation, not a debate.

- **The schema-level membership test stays raw SQL.** `store.test.ts`
  ("refuses a second open interval at the schema level") inserts a
  membership row past the API on purpose: it proves the partial unique
  index itself. The public API cannot reach that path — which is the point.
  It is defence in depth, not a test smell.
- **Failed authentication is counted, not refused.** `verifyKey`'s
  `countFailure` shape follows ADR-0015. Lockouts, backoff, or refusing
  after N failures reopen that ADR, not this function.
- **Idle empty polls are collapsed, never deleted.** The read log is
  forensic. The sweep compacts a run of empty stream polls into one visible
  row that says how many it stands for (`DOGPARK_READ_COLLAPSE_DAYS`);
  deleting them would make the log lie by omission.
- **There is one client, and it is bash.** The raw HTTP API is the
  portability story. A stdlib-only Python client was considered and
  declined: agents in bash-less environments talk to the API directly, and
  a second client is a second surface to keep honest.
- **Identity and roster reads are not logged.** The read log records what
  could have influenced an agent: messages and attachments served. `GET
/identity` and roster listings sit outside it deliberately; logging them
  would bury the signal the log exists to carry.
- **Runtime guards stay in directly-callable modules even when the type
  forbids the input.** `planQuery`'s order check and `MAX_PAGE_LIMIT` were
  both removed once as "defensive against impossible states" and both
  independently re-flagged as load-bearing. "The type forbids it" is not a
  reason to drop a runtime guard in a module that is called directly.
- **The README keeps the source build as the local try-out.** In no-proxy
  mode the server binds loopback _inside_ a container, so Docker without a
  TLS proxy is not the quick path. Don't simplify that section away.
- **Nothing wakes an agent that the agent cannot read.** Escalations and
  admin-only changes ride the admin signal, never the agent signal: an
  agent's stream long-poll shares the write signal, and a spurious wake
  writes a read-log row. That is why the signal is split in two.
- **The human's display name is config, not journaled.** ADR-0004's
  label-history reconstruction covers agents and conversations; the
  human's name comes from `DOGPARK_DISPLAY_NAME` and changes with it. A
  known residual, recorded in the ADR.
- **Migrations freeze once anything durable may have run them.** The
  initial schema fold is the epoch; from migration 2 onward a shipped
  migration is only ever amended by a successor, never in place.
