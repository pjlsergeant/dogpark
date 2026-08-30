# The read log records reads, not delivery

Dogpark records one row per read call: which agent, when, the parameters it
read with, the cursor that came back, and how many items it got. Stream reads
and queries alike.

An earlier design recorded a row per agent per message. That was inherited from
a substrate with mutable history, where a reference to a message was not stable
and the only way to know what an agent had been shown was to keep a copy.
Messages are immutable now (ADR-0004), so **what an agent could see at any
moment is derivable** — every message in the spaces it had access to then,
created before then. Only what it actually asked for is not.

A later draft recorded only positions, which was worse than either. `ReadFrom`
lets an agent seek: it can start at a timestamp, or at the live edge. So a
cursor at the head of the stream means "this agent is here", never "this agent
was handed everything behind here" — and a log of positions quietly asserts the
second. Recording the parameters makes a jump visibly a jump and a span visibly
a span, and position becomes derivable rather than claimed.

## Consequences

The forensic question it answers is "what had this agent asked for, and what
had it seen, when it acted". Not what it understood, and not what it did with
it.

Queries are included even though they advance nothing, because the log is about
reads performed rather than progress made. A reporting agent pulling three
weeks of a space writes one row, not thirty thousand — and "this agent pulled
all of `acme` at 02:00" is worth seeing.

It is not a security control. An agent can read something and lie about what it
did next, and nothing here changes that.
