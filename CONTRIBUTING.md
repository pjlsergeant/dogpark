# Contributing

`docs/architecture.md` describes the design; `docs/adr/` records why;
`CONTEXT.md` binds the two words that must not blur. This file holds the
process rules, for humans and reviewing agents alike.

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

Some choices in this codebase look like smells and are deliberate — a
raw-SQL test, a runtime guard the types make look redundant, a README
section that resists simplification. Each carries its reasoning in a
comment at the site, and that comment is the citation: an objection that
does not engage with it was already answered.

To reopen one, steelman it first — state the current position's strongest
case in your own words, then say precisely where it fails. An objection
that clears that bar gets engaged on the merits.

This list below is for positions that keep getting re-raised _despite_
their site comment. It is deliberately empty today; entries are earned,
not seeded.

_(none yet)_
