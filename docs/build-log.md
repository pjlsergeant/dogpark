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

## Security review of the implementation

Two reviewers went at the built system. What they found, and what was decided.

### Idempotency replay bypassed current access — the worst thing found

Replaying an idempotency key returned the stored outcome *before* checking
current membership. An agent removed from a space could therefore recover a
message's body, title and attachment metadata from it, using keys it had
generated itself. The same hole existed in the escalation replay path.

Authorization now happens before the stored outcome is read, and before the
hash comparison — so a revoked agent gets the same `not_found` whether or not
its replayed request matches, and the same answer as for a space that never
existed. Ordering the checks the other way would have leaked existence through
the difference.

### `DOGPARK_TRUST_PROXY` is an address list, not a boolean

A boolean meant trusting `X-Forwarded-*` from anyone who could reach the port.
That let an attacker claim any client address, bypassing login throttling, and
claim `X-Forwarded-Proto: https` while speaking plaintext — defeating the
refusal the setting exists to enforce. It now names the addresses whose headers
are believed.

### The re-entrancy guard was worse than the bug it fixed

A guard was added to stop two overlapping drains double-sending an escalation.
But `fetch` had no timeout, so a webhook that accepts a connection and never
answers held the guard for the life of the process: every later escalation
silently unsent, nobody paged, nothing saying so. Sends now abort after ten
seconds and retry on the normal backoff.

A fix that converts a rare duplicate into a permanent silence is not a fix.

### Backwards paging: what a cursor means

`Range.order: 'newest'` pages backwards from the end, and the decisions worth
recording are: a `newest` page is returned **newest-first**, because a request
for "newest" whose first element is the oldest is a trap; `nextCursor` is
always the last item handed over, so `after` means "continue past this, in the
direction you are travelling" and the rule is identical in both directions; and
the first backwards page anchors at the sequence tip as it stood when the read
began, so writes mid-walk cannot shift the window.

### Deferred: the human's writes are not durably idempotent

The store keys idempotency on an agent id, and there is no human row, so the
HTTP layer keeps an in-memory table to stop a double-click double-posting. A
double-click straddling a restart still double-posts, and it maintains a second
copy of the store's rules that can drift.

The fix is a migration keying idempotency on a writer that may be the literal
`human`, since ids are base32 and cannot collide with it. Not done: it is a
migration plus a coordinated change across two layers, and the failure it
prevents is a duplicate message rather than a lost one.

## What the auth throttle actually protects

Worth recording because it was got wrong three times.

An unauthenticated caller can present any key. The first attempt to bound that
refused a request when both the source address and the agent id claimed in the
key had spent their budget. That was bypassable: once the address bucket was
spent, rotating a fabricated id gave every attempt a fresh claim bucket.

Refusing on either bucket alone is worse. The address is shared by every agent
on one host, which a fleet often is, so refusing on it locks out neighbours.
The claimed id is public — it is the middle of every key, and any agent can
list its peers — so refusing on it lets anyone lock out a named agent.

The mistake was assuming there was expensive work to protect. Verification is
one SHA-256 and an indexed lookup: the store deliberately does not stretch,
because a key is 256 random bits with no dictionary behind it. The only real
cost of a bad attempt is the counter write.

So neither bucket refuses a request. They bound the *write*, a rejected key is
always 401, and request-rate floods belong to the reverse proxy this design
already assumes is in front. A fix that locks out legitimate callers to save a
hash is not a fix.

## A missing header is not consent

In proxy mode a request was refused only if `X-Forwarded-Proto` said plaintext.
A request that reached the process directly could omit the header and be
served — and proxy mode binds `0.0.0.0`, so an exposed port carried bearer
tokens in the clear. Treating silence as consent made the check optional for
exactly the caller it existed to stop.
