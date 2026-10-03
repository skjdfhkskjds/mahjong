# Human transport adapter

The human transport adapter is the presentation boundary in the
[backend redesign](README.md). It exposes the player's API through a WebSocket
stream behind the server-side [seat mailbox](seat-mailboxes.md). The
[runner](runner.md) communicates through that mailbox and does not depend on
WebSockets or connection status.

## Communication and trust

The adapter associates an authenticated participant with an authorized seat and
translates client messages into the participant interface. Client-supplied seat
identity, readiness, and proposed moves are untrusted and must be validated at
their appropriate boundaries. Knowing a session identifier does not grant seat
authority.

The adapter handles WebSocket setup, closure, reconnect, and stream delivery.
Connection changes remain behind the mailbox abstraction. A disconnected client
does not release its match seat or pause the runner; the server-side mailbox can
still supply fallback moves when requested.

## Outbound information

Publish only the permitted view and available actions for the particular seat,
plus intended lifecycle, deadline, result, and stop-request messages.
Canonical state and internal game events are not WebSocket messages. The adapter
must not broadcast one seat's private view or moves to other seats.

Messages and acknowledgements that depend on authoritative writes are delivered
only after the runner has successfully persisted those writes. Reconnect obtains
a current permitted view through the mailbox boundary rather than exposing
canonical state.

## Interface details still open

The design does not yet choose wire envelopes, protocol versions, payload schemas,
stream sequence numbers, buffering, retry rules, or acknowledgement forms. Those
choices must support the runner's complete response batches and stale-message
checks, including replies arriving after a deadline or after a new match starts
under the same session ID.

Transport authentication and deployment compatibility must be specified with the
implementation. This design document does not change the current
[session and request security](../session-and-request-security.md) implementation
or its wire protocol.
