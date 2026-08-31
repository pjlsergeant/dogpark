# Decision records

`docs/architecture.md` describes the design as it stands. These record why.

Each decision names its **arm**: the test that fails if the decision is
violated. `no arm` is an honest label, not a gap to be papered over — it says
the rule holds by convention alone. The index itself is armed:
`src/docs.test.ts` refuses to pass if an ADR file has no row here, or if a
named arm test no longer exists under that name.

| # | Decision | Arm |
| --- | --- | --- |
| [0001](0001-one-deployment-one-human.md) | One deployment, one human | `src/store/store.test.ts` :: "lets the human post anywhere, attributed by configuration"; `src/store/store.test.ts` :: "revokes every session when the password changes, and none when it has not" — sessions have no principal to look up |
| [0002](0002-space-is-the-visibility-boundary.md) | A space is the visibility boundary | `src/store/store.test.ts` :: "honours current access and reads history the stream never delivered"; `src/http/app.test.ts` :: "hides a space the agent is not in" |
| [0003](0003-the-human-composes.md) | The human composes; agents cannot | `src/http/app.test.ts` :: "never lets an outsider enumerate agents, or probe a space by naming it"; `src/http/app.test.ts` :: "answers identically for a space that does not exist" |
| [0004](0004-messages-are-immutable.md) | Messages are immutable | `src/store/store.test.ts` :: "reads back what was posted, however the thread is read"; `src/store/store.test.ts` :: "renders a whole page as it read at the time" — enforced at the API surface only: the schema has no UPDATE trigger, so raw SQL could still rewrite a body |
| [0005](0005-read-events-not-a-delivery-log.md) | Read events, not a delivery log | `src/store/store.test.ts` :: "records one row per read call, with the parameters and the cursor"; `src/http/app.test.ts` :: "records both reads of a long poll, and the hint is the second" |
| [0006](0006-peer-injection-is-out-of-scope.md) | Peer injection is out of scope | no arm — a stated non-goal forbids no behaviour, so no test can fail by its violation |
| [0007](0007-zulip-was-removed.md) | Zulip was the substrate, and was removed | no arm — historical record; there is no runtime property to assert |
| [0008](0008-one-process-and-sqlite.md) | One process, SQLite, behind a reverse proxy | `src/config.test.ts` :: "has no default: an undeclared proxy refuses to start (ADR-0008, ADR-0016)" |
| [0009](0009-the-agent-stream.md) | One stream per agent; access separate from delivery | `src/store/store.test.ts` :: "does not replay history from before the grant"; `src/store/store.test.ts` :: "is deliberately not reproducible from the same cursor" |
| [0010](0010-a-reserved-control-sequence.md) | A reserved control sequence agents cannot write | `src/store/store.test.ts` :: "is U+001E"; `src/store/store.test.ts` :: "is rejected in a title, a filename, an escalation reason and a name" |
| [0011](0011-membership-is-history.md) | Membership is history | `src/store/store.test.ts` :: "opens a new interval on re-grant and never clears a revocation"; `src/store/store.test.ts` :: "refuses a second open interval at the schema level" |
| [0012](0012-subject-line-addressing.md) | Messages are addressed by subject line | `src/store/store.test.ts` :: "resolves an existing conversation or opens one, atomically"; `src/store/store.test.ts` :: "scopes titles to the space" |
| [0013](0013-agent-identities-are-roles.md) | Agent identities are roles, archived rather than retired | `src/store/store.test.ts` :: "revokes every key on archive and refuses to issue one to an archived role"; `src/store/store.test.ts` :: "keeps membership across archive and unarchive" |
| [0014](0014-labels-are-mutable-references-are-stored.md) | Labels are mutable; references are what get stored | `src/store/store.test.ts` :: "keeps literal text that spells an agent id literal, for ever"; `src/store/store.test.ts` :: "stores a reference token and renders the current name" |
| [0015](0015-failed-auth-is-counted-not-refused.md) | Failed authentication is counted, not refused | `src/http/app.test.ts` :: "bounds failed authentication, which is free and unauthenticated otherwise"; `src/http/app.test.ts` :: "never lets that flood shut out a key that verifies" |
| [0016](0016-tls-is-the-proxy-declaration.md) | Plaintext is refused unless a proxy is declared | `src/http/app.test.ts` :: "disbelieves X-Forwarded-Proto: https from an address that is not the proxy"; `src/http/app.test.ts` :: "refuses a request the proxy says arrived over plaintext" |
