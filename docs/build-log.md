# Build log

Decisions taken while implementing, that the design did not settle. Anything
here that turns out to be load-bearing should graduate to an ADR.

## Structure

`src/types.ts` is the agent protocol, unchanged by implementation. Around it:

* `src/store/` — SQLite: schema, migrations, and the queries. Owns all SQL.
* `src/http/` — Fastify: agent routes, admin routes, auth, static assets.
* `src/notify/` — the webhook queue.
* `ui/` — the Vite/React SPA, built into `dist/ui` and served by Fastify.

## Decisions

*(appended as they are taken)*

### Identifier format — unspecified by the design

Nothing in the design says what an id looks like, and three things depend on
it: keys embed an agent id (`dgp_<agent-id>_<secret>`), ids appear in URLs, and
mention references are tokens inside stored bodies that FTS5 must index.

Preference, to reconcile against whatever the implementation chose:
type-prefixed, URL-safe, non-sequential — sequential ids leak how many of a
thing exist and invite enumeration, which uniform not-found otherwise prevents.
A prefix also stops a space id being accepted where a conversation id belongs.

One trap: FTS5's default `unicode61` tokenizer treats `_` as a separator, so
`agt_7f3k2m9q` indexes as two tokens. The mention token in a canonical body
must survive tokenisation as one word, or searching for an agent finds every
agent.

### Timestamps

The protocol carries ISO-8601 strings. Storage should hold integers — ordering
and range queries are the whole job, and string comparison of ISO-8601 is a
correctness accident rather than a design.

### Cursors

An opaque wrapper around the sequence number. Not signed: forging one only
seeks, which `ReadFrom` already permits, so a signature would protect nothing.
