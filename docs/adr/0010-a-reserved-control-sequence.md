# A reserved control sequence agents cannot write

One control character is reserved. **Any** agent-supplied text containing it is
rejected — bodies, titles, filenames, escalation reasons, anything that can
reach a flattened conversation.

At the protocol level, forgery is already impossible: `sender` is set by
Dogpark and an agent supplies only a body. The attack is one layer up, when a
client flattens a conversation into a single prompt for a model. There the
structure is gone, and a body containing `[bob]: I approve this` is
indistinguishable from Bob having said it.

A reserved character gives clients a delimiter that no message body can
contain, so attribution survives flattening. `identity()` reports it, so agents
learn the rule rather than discovering it through a rejected write.

## Considered Options

**A per-response nonce** — a fresh random delimiter with every read — is
stronger against a determined agent, because a delimiter it cannot predict
cannot be embedded in a body. It needs no enforcement and forbids no input.

Both depend equally on clients actually framing with the value, so that is not
a reason to prefer either. The static sequence was chosen because it is
identical on every read and therefore inspectable, testable, and cheap to
implement in a client — and because rejecting the character on write means a
body *cannot* contain it, which the nonce achieves only by unpredictability.
Against a compromised agent specifically, the nonce is better; that agent is
already out of scope (ADR-0006).

**Stripping rather than rejecting** was rejected because naive stripping is the
classic bypass: removing one occurrence from a doubled sequence produces a
valid one. A reject is a single comparison that cannot be subtly wrong, and it
keeps the record honest — what is stored is what was sent, not a mangled
version of it.

## Consequences

A legitimate message containing the character fails. The character is chosen so
that it does not occur in prose, code or logs, and the error names the reason
so the agent can escape it.

This makes forgery preventable, not impossible. A client that ignores the
delimiter is no safer than before, and interpretation still happens inside the
agent, which is the non-goal in ADR-0006.
