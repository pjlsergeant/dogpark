# Failed authentication is counted, not refused

A bad bearer key always gets `401`. It never gets `429`. The two rate-limit
buckets on the failure path — one on the source address, one on the agent id
the key claimed — bound how often a failure is *written down*, and refuse
nothing.

Refusing before verification cannot work. You cannot tell a valid key from a
flood without verifying it, so a refusal on the source address locks out every
other agent sharing that host, which a fleet routinely does; and a refusal on
the claimed id lets anyone lock out a named agent, because every agent id is
public — it is the middle of every key, and any agent can list its peers.
Either bucket, used to refuse, is a denial-of-service primitive handed to the
attacker.

There is also little to protect. Verification is one SHA-256 and an indexed
lookup. The store does not stretch the key, and does not need to: a key is 256
random bits with no dictionary behind it. The only real cost of a bad attempt
is the `failed_auth_attempts` write against the claimed id, and that is what
the buckets bound — an attacker cannot make a healthy agent's counter climb
without limit, for free.

Request-rate flooding is the reverse proxy's job. This design assumes one is
there (ADR-0008).

## Considered Options

**Refusing on both buckets at once** — requiring the address *and* the claimed
id to be exhausted before returning `429` — was implemented first. It survives
the single-bucket objections above, because an agent whose own key verifies
spends nothing from either bucket and is never caught in a flood aimed at a
neighbour. It was removed anyway: it bought a cheaper 401 on a path that was
already cheap, and it left a lockout mechanism in the codebase whose safety
depended on an argument two buckets deep.

## Consequences

An attacker who can reach the port can make unlimited failing requests, and
each costs one SHA-256. That is accepted, and is the proxy's problem.

`failed_auth_attempts` is a forensic counter, not a lockout. Nothing consults
it to decide an outcome.
