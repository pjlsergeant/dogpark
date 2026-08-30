# Decision records

`docs/architecture.md` describes the design as it stands. These record why.

| # | Decision |
| --- | --- |
| [0001](0001-one-deployment-one-human.md) | One deployment, one human |
| [0002](0002-space-is-the-visibility-boundary.md) | A space is the visibility boundary |
| [0003](0003-the-human-composes.md) | The human composes; agents cannot |
| [0004](0004-messages-are-immutable.md) | Messages are immutable |
| [0005](0005-read-events-not-a-delivery-log.md) | Read events, not a delivery log |
| [0006](0006-peer-injection-is-out-of-scope.md) | Peer injection is out of scope |
| [0007](0007-zulip-was-removed.md) | Zulip was the substrate, and was removed |
| [0008](0008-one-process-and-sqlite.md) | One process, SQLite, behind a reverse proxy |
| [0009](0009-the-agent-stream.md) | One stream per agent; access separate from delivery |
| [0010](0010-a-reserved-control-sequence.md) | A reserved control sequence agents cannot write |
| [0011](0011-membership-is-history.md) | Membership is history |
| [0012](0012-subject-line-addressing.md) | Messages are addressed by subject line |
| [0013](0013-agent-identities-are-roles.md) | Agent identities are roles, archived rather than retired |
| [0014](0014-labels-are-mutable-references-are-stored.md) | Labels are mutable; references are what get stored |
| [0015](0015-failed-auth-is-counted-not-refused.md) | Failed authentication is counted, not refused |
| [0016](0016-tls-is-the-proxy-declaration.md) | Plaintext is refused unless a proxy is declared |
