# ADR 0014: Upgrade canonical game state and gameplay protocol to v2

Status: accepted

Date: 2026-09-01

## Context

Canonical game state schema v1 and protocol v1 support only setup,
draw/discard, and exhaustion. Claims, melds, reaction phases, legal actions,
deadlines, and scored results cannot be represented by either strict schema.
Existing schema-v1 state and event hashes are already permanent compatibility
evidence and must not be reinterpreted or rewritten.

The Activity has not been externally deployed, so the project has no live v1
clients or cached production assets to preserve. A strict v1 client also cannot
safely accept a partial projection of a v2 reaction or result.

## Decision

Introduce canonical game state schema v2. It retains the established wall and
player facts and adds declared melds, reaction source, winning provenance,
prevailing wind, and terminal scored results. Fresh games begin with v2.

Historical v1 JSON remains decoded and replayed by its original reducer. After
the stored chain and checkpoint verify, `TableRoom` appends one deterministic
`game/state-upgraded` event, hashes it from the previous hash with the existing
canonical hash payload, and atomically writes the v2 checkpoint. Earlier event
bytes and hashes never change. The authority-only upgrade does not increment
viewer `stateVersion` when its projection is unchanged.

Canonical JSON ordering, physical tile IDs, SHA-256, and event-hash payload
version 1 remain unchanged. State schema version is independent from the hash
encoding algorithm. Unknown state, event, or storage versions fail closed.

Introduce gameplay protocol v2 as the only supported live wire major. The
connection explicitly requests it with
`/api/table/socket?protocolVersion=2`; absence, version 1, and every unsupported
major receive an upgrade-required control message and dedicated close before
gameplay messages are accepted. The query chooses representation and grants no
authority. Commands and strict viewer snapshots add reactions, exact physical
meld actions, kongs, legal self-actions, deadlines, automation/abandonment
status, and scored results. Canonical events, private opponent actions, losing
win scores, wall order, and hashes remain outside the wire union.

Do not build a dual reader or v1 overlap path. Deploy the v2 client and Worker
atomically, with the Activity shell naming content-hashed client assets so a
Worker cannot serve an ambiguous mutable bundle. Rollback restores both client
and Worker together. Historical protocol-v1 fixtures remain evidence of the
old contract, not supported socket behavior.

## Consequences

The project keeps byte-for-byte historical replay while gaining a coherent
rules state for Milestones 5 and 6. Storage schema v4 must retain the permanent
TableRoom v1 fixture and add a v3 fixture containing an active schema-v1 game
and hash chain, proving verification, upgrade, projection equivalence, eviction,
and continued play.

Client and Worker validators remain closed and version-specific. Wire tests
prove v1/absent-version rejection and v2 behavior rather than dual-version
overlap. Protocol and canonical state can evolve independently, and neither
migration authorizes exposing authority-only data.
