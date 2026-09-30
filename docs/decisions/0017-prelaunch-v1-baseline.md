# ADR 0017: Coalesce prelaunch formats into v1

- Status: accepted
- Date: 2026-09-23

## Context

The Activity is a work in progress and has not gone live. Development added
session payload v2, gameplay protocol v2, canonical game state v2, and several
TableRoom storage schemas while implementing the first release. There is no
persisted deployment data to migrate. Keeping these intermediate contracts as
supported versions would add compatibility code without a deployed consumer.

## Decision

The complete current session payload, viewer-safe gameplay protocol, canonical
game state and events, and TableRoom storage layout are each their initial v1
contract. Fresh storage creates the complete schema directly. Runtime decoders
reject unsupported versions and malformed persisted or external input.
Prelaunch migration and state-upgrade paths, along with their intermediate
fixtures, are retired. A permanent fixture of the complete v1 storage layout
proves recovery and integrity checking.

The `hong-kong/v1` rules profile, `random/v1` bot policy, shuffle algorithm,
canonical JSON encoding, and version-1 event-hash payload retain their
existing meanings. Coalescing changes genesis bytes and their resulting hashes;
prelaunch hash values are discarded. It does not change Mahjong decisions, the
hash algorithm or payload format, privacy boundaries, or the server's
persist-before-publish behavior.

The client and Worker continue to ship atomically with content-hashed assets.
There is no deployed earlier protocol to support. A future incompatible
contract must receive its own version, compatibility decision, and fixtures
before deployment.

## Consequences

The first live release has one coherent v1 baseline. A development database
written by an earlier prelaunch build is not a supported migration source and
must be recreated. ADR 0014's v1-to-v2 upgrade and legacy replay requirements
are superseded. The versioning and security principles in ADRs 0011–0013 remain
in force for the new baseline.
