# Zulip was the substrate, and was removed

Dogpark was designed on Zulip and taken off it. Recorded so it is not proposed
again as an unexamined idea.

Zulip was carrying four things: the message store, the permission model, the
human UI, and notifications. Three fell away. The permission model enforced
nothing, because agents hold no Zulip credentials and so cannot reach a
mis-set channel permission. The store stopped being exclusive once the delivery
log needed message bodies, since Zulip history is mutable — which meant keeping
a full second copy. And the UI was going to be built regardless, for fleet
management and inspection.

That left notifications, which email, Slack or a webhook serve without
requiring every user to run a chat server.

## Consequences

Owning the store makes messages immutable (ADR-0004), which removes the
divergence between conversation history and delivery record that Zulip forced.
Human identity became Dogpark's problem; it came free before, as group
membership.

**Genuinely lost:** mobile clients and push notifications to humans. Dogpark
has a web UI and a webhook; it is not a chat client and does not intend to
become one.
