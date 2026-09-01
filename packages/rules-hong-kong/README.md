# `@mahjong/rules-hong-kong`

## Owns

The project-defined, accepted Hong Kong rules profile and its pure implementation. The canonical schema-v2 surface includes physical tiles, deterministic shuffle from explicit random bytes, dealer selection, the initial deal, recursive bonus replacement, draw/discard decisions, private reaction intentions, chow/pung/kong claims, every kong form, replay, viewer projections, and invariants.

## Does not own

Discord, Cloudflare, storage, networking, UI, room membership, table access, operational timeout policy, scoring, or match progression. Structurally eligible wins are authority-only until the scorer can enforce the minimum and produce payments.

## Dependencies

May import `@mahjong/game-core` through its public entry point and runtime schema libraries. It compiles without Node, DOM, React, Discord, or Workers ambient types.

## Public entry point

Only `@mahjong/rules-hong-kong` is public. Consumers may not deep-import implementation files.

## Invariants

- `hong-kong/v1` means the exact profile validated by `hongKongProfileSchema`.
- The accepted tile inventory contains 144 unique physical IDs.
- Tile IDs follow the published canonical order and cannot be renumbered within v1 after shuffle vectors are published.
- The initial deal assigns 14 raw tile slots to East and 13 to every other seat; bonus replacement then restores those structural counts.
- Bonus tiles never enter the structural hand and replacements come from the wall tail.
- Canonical events replay to byte-equivalent state and preserve all 144 physical tiles in exactly one location.
- Historical schema-v1 state and event bytes retain strict decoding and replay. The existing unversioned starter and command surface remain schema v1 for deployed callers; new integrations opt into schema v2 explicitly and upgrade verified v1 histories only through a deterministic event.
- Public melds preserve exact physical IDs and provenance; kongs count as three structural tiles despite containing four physical tiles.
- Projections expose a player's own hand/actions, public bonuses, discards and melds, and concealed counts without exposing opponents' hands, intentions, eligibility, or the wall.
