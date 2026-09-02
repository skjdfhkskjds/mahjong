# ADR 0011: Version persistent room state and viewer-safe lobby messages

Status: accepted

Date: 2026-08-23

## Context

Milestone 3 adds the first mutable, client-driven room state. The access schema from Milestone 2 already persists table identity, membership, binding authority, sessions, capabilities, and connection grants, but its WebSocket sends only a fixed lobby placeholder. Before seats and readiness can be stored, the project needs distinct meanings for wire compatibility, aggregate concurrency, storage migrations, and future rules state.

Canonical room data and future rules events may contain facts that a viewer must not receive. Command replay also needs an actor-scoped result that is independent of broadcast delivery.

## Decision

`protocolVersion` is the WebSocket wire major version. Milestone 3 continues at version `1`; clients and the Worker reject any other value. The Activity client and Worker ship in one deployment, so this version has no rolling mixed-version overlap window. A future incompatible wire format uses a new major version and requires an explicitly dual-reading deployment if overlap becomes necessary.

ADR 0014 records that Milestones 5–6 precede external deployment, so gameplay
protocol v2 replaces v1 atomically without a dual-reading overlap. Protocol-v1
requests are rejected and closed; v1 remains only a historical fixture.

`storageSchemaVersion` is the `TableRoom` SQLite schema version. Construction transactionally migrates the Milestone 2 version-1 schema to version 2 while preserving access, binding, capability, session, and connection-grant records. Unknown future versions fail closed. The oldest committed schema fixture remains permanent migration evidence.

`stateVersion` is the monotonic revision of persisted, viewer-visible `RoomState`. Table creation is genesis at revision zero. Each accepted atomic command that changes seats or readiness increments it exactly once. Adding a table member also increments it because membership changes the spectator projection. Rejected, duplicate, no-op, connection, disconnection, resync, session, capability, and binding-authority operations do not increment it. A client's `expectedStateVersion` is an optimistic-concurrency precondition; a stale command is rejected and followed by that viewer's current snapshot.

`RoomState` owns membership projection, the four exclusive seats, lobby readiness, and later table lifecycle. Seat ownership is an actor reservation and therefore survives socket closure, reconnect, hibernation, and Durable Object eviction until an explicit leave command. All authoritative room data lives in SQLite. WebSocket attachments remain limited to bounded connection and session identity.

`rulesetVersion` identifies the exact game semantics, currently `hong-kong/v1`. No rules-owned `GameState` exists during the lobby. Starting a hand will create separately typed rules state pinned to that version; lobby commands never become Hong Kong domain events merely because both aggregates live in `TableRoom`.

`viewVersion` is not introduced while the protocol sends full viewer-specific snapshots. `stateVersion` is sufficient for stale detection, but clients must not infer that every canonical or future hidden transition will produce a visible delta. If deltas are introduced, their independent viewer-stream sequencing must be decided first.

`encodingVersion` remains reserved for canonical bytes used by fairness commitments and hashes. Milestone 3 creates no such bytes.

Lobby commands use a runtime-validated envelope containing protocol version, actor-supplied command ID, expected state version, and one command payload. The table stores the canonical request and an actor-scoped receipt in the same SQLite transaction as an accepted mutation. Replaying the identical command ID and input by the same actor returns the same receipt without applying twice. Reusing the ID with different input or from another actor returns a generic collision and reveals no original actor, command, or response.

Server messages are a closed union of viewer-specific snapshots, actor-scoped receipts, and session-control messages. A snapshot is rebuilt independently for each authenticated socket. Canonical room records, command requests, stored receipt internals, and future domain events are not members of the wire union.

## Consequences

Clients can safely retry after uncertain delivery, detect stale local state, and recover through a complete projection. Reconnect does not release a seat, and an evicted object reconstructs the same lobby from SQLite without treating attachments as authority.

Full snapshots may repeat public lobby data after each transition, but they keep the privacy boundary explicit and avoid premature delta sequencing. Future gameplay must decide how hidden-only canonical transitions relate to viewer stream positions before adding deltas.

Storage migration and protocol evolution are separate compatibility obligations. A storage migration does not imply a wire-version change, and an editorial rules clarification does not alter any of these versions unless fixture semantics change.
