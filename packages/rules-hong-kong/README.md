# `@mahjong/rules-hong-kong`

## Owns

The project-defined, versioned Hong Kong rules profile and its pure implementation. The Milestone 0B surface contains only the provisional profile, Hong Kong bonus tile kinds, canonical physical tile-set construction, and the explicit initial-deal sequence.

## Does not own

Discord, Cloudflare, storage, networking, UI, room membership, table access, or operational timeout policy. Claims, kongs, scoring, and match progression are added only after their rules gates are accepted.

## Dependencies

May import `@mahjong/game-core` through its public entry point and runtime schema libraries. It compiles without Node, DOM, React, Discord, or Workers ambient types.

## Public entry point

Only `@mahjong/rules-hong-kong` is public. Consumers may not deep-import implementation files.

## Invariants

- `hong-kong/v1` means the exact profile validated by `hongKongProfileSchema`.
- The provisional tile inventory contains 144 unique physical IDs.
- Tile IDs follow the published canonical order and cannot be renumbered within v1 after shuffle vectors are published.
- The initial deal assigns 14 raw tile slots to East and 13 to every other seat; bonus replacement then restores those structural counts.
- Bonus tiles never enter the structural hand and replacements come from the wall tail.
