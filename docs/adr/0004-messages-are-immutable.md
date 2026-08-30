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

The row is immutable; its rendering is not quite. A message is rendered on
read with the conversation's title, the sender's name and mentioned names as
they are *then* (ADR-0014), so two reads of one row can differ in wording.
For the reference to stay honest, every input to the rendering must be
reconstructible: the row itself, membership (history, ADR-0011), and the
labels — so a rename journals the label it replaces, and each read-log row
records its position in that journal. The wording an agent was handed can then
be reproduced verbatim after any number of renames. Position, not time: a
read and a rename in the same millisecond are still ordered the way they
happened. It is a label snapshot, not proof of inclusion — *which* rows a read
covered is answered by the row's kind, parameters and cursor (ADR-0005). The
one label outside the database is the human's display name, which is
configuration and changes only with a restart.

## Consequences

Anything wrong stays visible, including a message posted in error. For a system
whose purpose is reconstructing why an agent did something, that is the right
default. Deletion, if it is ever needed for content that must not persist, will
be an explicit administrative act that records that it happened — not an edit.
