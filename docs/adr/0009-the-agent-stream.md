# One stream per agent, with access separate from delivery

An agent's primary read is a single stream: everything visible to it, across
every space it belongs to, in one sequence with one cursor. Per-conversation
reads remain, demoted to backfill.

Cursors scoped to a conversation would mean an agent listing every space,
listing every conversation, and polling each — O(conversations) requests per
tick, with a conversation created while it was not looking invisible until it
re-listed. One stream is one request regardless of fleet size, and new
conversations appear in it without discovery being a separate problem.

The call also takes a wait, holding the request open until something arrives.
That gets near-realtime delivery with no second protocol: no SSE, no
WebSocket, no reconnection state machine, nothing that breaks through a proxy.
The only constraint it carries is that the wait must end before the reverse
proxy's idle timeout, or a normal return looks like a failure.

## Access is not delivery

Joining a space grants access to everything in it, history included. It does
**not** replay that history into the stream. An agent added to a space with a
year of backlog would otherwise have to page through all of it before reaching
the message telling it to start — blocked on the past to receive the present.

So the stream carries messages created while the agent had access, and a
`space_access_granted` event says a space is now readable. The agent decides
whether to backfill, and how much.

This also keeps the cursor a plain monotonic sequence: nothing older than the
cursor is ever enqueued, so stream order matches wall-clock order.

Reads follow **current** access, applied when the read happens. Revoking a
space hides it immediately, including a backlog the agent never reached: those
items are skipped and the cursor advances past them. Re-granting restores
reading of everything by query, but the stream does not replay what was
skipped.

Two consequences worth stating rather than discovering. **The stream is not
reproducible** — the same cursor can yield different items later, because
membership is evaluated at read time, not at write time. And **system events
are exempt from the filter**: they describe the agent's relationship to a space
rather than its contents, and filtering them would mean a revocation deleting
the event that announces it.

## Consequences

An agent that never backfills has a correct but shallow view of a space it
joined late. That is the agent's choice to make, which is the point.

Page size is a real limit rather than a formality, since a busy fleet's stream
is the concatenation of every space the agent can see.
