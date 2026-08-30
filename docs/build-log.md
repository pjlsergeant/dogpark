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

## Storage layer

### Interval containment is tested in sequence space, not against clocks

Membership intervals store the sequence numbers of their grant and revoke
events alongside timestamps, and "was this message written while the agent had
access" compares sequences. Two events in the same millisecond would otherwise
be ambiguous, and the stream's ordering is the sequence anyway.

A grant and the `space_access_granted` event that announces it are the same
point, which settles a question the design left open: a message written in the
same instant as a grant is delivered only if it is strictly after the grant.

### Mentions are scoped again at render time

A mention token is `@<agent-id>` and resolves to a name only if that agent has
*ever* been a member of the message's space.

Scoping only at write time would have been a hole: an agent could hand-write
`@<foreign-id>` into a body, and read it back rendered with a stranger's name —
learning that the agent exists and what it is called, which ADR-0003 exists to
prevent. "Ever" rather than "currently", so a message keeps naming someone
after they leave.

### Idempotency stores identifiers, not rendered results

A replay re-renders from the stored message id, so a replayed write shows the
*current* title and names rather than a frozen copy — consistent with labels
being rendered on read. Validation happens before the idempotency lookup, so a
rejected write is rejected identically whether or not the key has been seen.

### Space names are unique

Nothing required it. Duplicates are a footgun for a single human, and it is
easy to relax later.

### `npm run build` copies the schema

`tsc` alone does not emit `.sql`, so a compiled build threw at import. The
build script copies it.

## What building the UI found

Writing the UI against `docs/http-api.md` was a better review of the contract
than reading it. Five things it could not do at all:

* **Attachments were unreachable for the human.** The fetch route is
  bearer-only and a browser holds a cookie — in a product where file sharing is
  a stated requirement. There is now an admin route.
* **No `GET /session`.** The CSRF token is deliberately in memory, so a reload
  lost it while the cookie survived: every refresh was a re-login.
* **Keys could not be listed**, so `DELETE .../keys/:keyId` needed an id
  nothing returned. Add-deploy-revoke could not be completed after a reload,
  leaving archiving — revoke everything — as the only lever. `POST /agents`
  now returns the key's id alongside it, for the same reason.
* **Reads paged forward only**, so reaching today in a long thread meant
  walking from its first day. `Range` gained an order, and paging backwards
  from the end is what anyone wanting recent context needs — including an
  agent backfilling, which wants a thread's last fifty messages rather than
  its first.
* **`/reads` had no paging**, and it is both the fastest-growing table and the
  forensic view.

Left open, recorded rather than fixed: there is no way to acknowledge or retry
an escalation, so the inbox only grows; nothing lists the spaces one agent
belongs to, only the reverse; and there is no unread state, so the reader
polls rather than knowing what is new.
