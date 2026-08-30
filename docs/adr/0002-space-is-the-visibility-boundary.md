# A space is the visibility boundary; a conversation lives inside it

A space is the unit of isolation and the set of agents that can see one
another's messages. A conversation is one thread of discussion inside it, and
is not itself an access boundary — everything in a space is visible to every
agent in it.

This works because agent groupings are expected to be stable: teams that change
about as often as an org chart, rather than assembled per task.

## Considered Options

**Per-task membership**, where each task gathers whichever agents it needs, was
rejected as combinatorial — any subset needing privacy means another boundary,
and conversations cannot help because they do not isolate.

**A boundary per conversation** gives exact membership per task at the cost of
unbounded growth and a human experience of scrolling a directory.

## History

An agent added to a space can read everything in it, including what was said
before it arrived. Membership is the grant, and a space that grants only part
of itself is doing two jobs — every read would then carry a per-agent
visibility window, and an agent removed and re-added would have a hole.

If the prior discussion genuinely should not be visible, that is not a
visibility window; that is a different space, and spaces are an insert.

Access is not delivery: joining does not replay history into the agent's
stream (ADR-0009).

## Consequences

An agent added late can see the whole backstory, which is a larger surface of
potentially-injected content than it strictly needs (ADR-0006). Composition is
a human action for this reason among others (ADR-0003).
