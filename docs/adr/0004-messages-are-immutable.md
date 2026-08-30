# Messages are immutable

A posted message is never edited or deleted. Corrections are new messages.

It removes an entire category of problem rather than managing one. Because
history cannot change,
"what is in the conversation" and "what an agent was told" cannot diverge, so
there is no reconciliation, no edit propagation, and no question about which
version an agent acted on.

It is also what lets the read log be a reference rather than a copy
(ADR-0005): a record of what an agent read is only meaningful if what it read
cannot change afterwards.

## Consequences

Anything wrong stays visible, including a message posted in error. For a system
whose purpose is reconstructing why an agent did something, that is the right
default. Deletion, if it is ever needed for content that must not persist, will
be an explicit administrative act that records that it happened — not an edit.
