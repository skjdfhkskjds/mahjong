# ADR 0012: Canonical game encoding and event hashes

Status: accepted

## Decision

Canonical `hong-kong/v1` game state uses schema version 1 JSON. Object keys are
serialized in Unicode code-unit order, arrays retain domain order, numbers are
finite JSON numbers, and unsupported JavaScript values are rejected. Physical
tiles are represented by their canonical integer IDs; the wall retains its full
permutation plus inclusive head and tail cursors.

Each event has a contiguous integer sequence. Its hash input is canonical JSON
of `{ event, previousHash, version: 1 }`, where `previousHash` is `null` at
genesis and otherwise the prior lowercase 64-character hexadecimal digest. The
event hash is the lowercase hexadecimal SHA-256 digest of the UTF-8 payload.

The versioned shuffle is `random-bytes-rejection-fisher-yates/v1`. The authority
supplies at least 1,028 bytes directly from its cryptographic random source. The
first 32-bit word is domain-isolated for uniform dealer selection; subsequent
words feed rejection-sampled descending Fisher–Yates. No low-state seeded PRNG
is used. Any semantic change requires a new algorithm or encoding version.

ADR 0014 extends this decision for Milestones 5–6. Canonical state schema v1
and every existing event/hash remain immutable. New games use state schema v2,
and existing live games reach it only through an appended deterministic upgrade
event. Canonical JSON ordering and hash-payload version 1 remain unchanged.

## Consequences

The Durable Object can verify and replay its persisted event stream across
evictions and runtime upgrades. Canonical state and events are authority-only;
the socket protocol carries independently constructed viewer projections.
