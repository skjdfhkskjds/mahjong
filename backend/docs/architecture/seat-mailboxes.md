# Seat mailboxes

A seat mailbox is the stable server-side participant interface in the
[backend redesign](README.md). The [runner](runner.md) publishes messages to it
and receives participant messages from it. The mailbox hides how the participant
communicates or chooses a move.

## Participant boundary

Each occupied seat has a mailbox associated with its participant. For a human,
the [transport adapter](transport.md) implements communication using a WebSocket
stream behind this boundary.

The mailbox remains available server-side when the client is disconnected. The
runner does not receive connection-status changes and continues normal response
rounds and deadlines. Seat assignment stays fixed during the match.

Human and bot implementations may share this interface. Bot implementation is
outside the present scope; server-side human fallback behavior is still required.

## Message responsibilities

From the runner, a mailbox receives the seat's permitted view, available moves,
response deadline, game results, intermission timing, stop-request notifications,
and deadline-exceeded requests for a move.

Toward the runner, the participant supplies seat readiness, proposed moves,
permitted passes, stop requests, and agreement messages. Exact message names,
envelopes, correlation identifiers, and acknowledgement shapes are not yet
specified.

The mailbox receives only information intended for its seat. It is not a route
for canonical hidden state or internal game events to reach a client.

## Fallback behavior

The runner publishes and tracks the deadline. When a required response is missing
at expiration, the runner asks the mailbox for a move. The mailbox supplies a
fallback through the ordinary gameplay response path, including when its client
is disconnected.

Fallback selection belongs to the participant implementation. The ruleset
validates the proposed move and resolves it with the complete response batch.
The runner neither chooses a fallback nor changes gameplay based on connection
status.

An invalid response is rejected before collection, and that seat may retry until
the original deadline. A fallback is subject to the same legality and
stale-response checks. Neither a duplicate reply nor a late fallback can count as
a second responding seat.

## Recovery and open details

Published opportunities, accepted partial responses, deadlines, and pending
fallback work need recoverable coordination records. A connection is not the
authority for those records; the [repository](repository.md) preserves them under
the runner's control.

Still to define are the human-versus-fallback race, fallback selection for each
legal-action representation, behavior when a fallback fails, delivery and retry
semantics, and how a recreated mailbox resynchronizes with the runner. A mailbox
abstraction does not itself choose a message broker or queue product.
