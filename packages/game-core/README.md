# `@mahjong/game-core`

## Owns

Small concepts that are demonstrably shared across Mahjong rulesets: opaque identities, physical tile identity, suited and honor tile kinds, winds/current-hand seats, viewers, and the pure command/event/reducer contract.

## Does not own

Bonus tiles, scoring, claims, kongs, match progression, networking, persistence, clocks, randomness, React, Discord, or Cloudflare APIs. Variant-specific concepts stay in their rules packages.

## Dependencies

This package has no runtime dependencies and may not import any other project package. It is compiled without Node, DOM, React, or Workers ambient types.

## Public entry point

Only `@mahjong/game-core` is public. Internal file imports from another package are prohibited.

## Invariants

- Identifiers are non-empty after trimming but preserve their original value.
- Physical tile IDs are non-negative safe integers.
- An accepted game decision emits at least one domain event.
- A rejected game decision contains at least one rule violation.
- Genesis is a JSON-safe, runtime-validated snapshot at event sequence zero; every later domain event is replayed in order through `evolve`.
- Canonical state, configuration, and domain events contain only finite JSON-safe values. Runtime-rich representations require an explicit codec outside the persisted contract.
