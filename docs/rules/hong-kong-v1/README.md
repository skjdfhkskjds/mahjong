# Mahjong Activity Hong Kong profile v1

Status: accepted

Last reviewed: 2026-08-23

This is the project's explicit friend-group Hong Kong Mahjong profile. It is not “the official” or universal Hong Kong ruleset: household, association, tournament, and older Hong Kong conventions disagree on flowers, dead walls, scoring, payments, and edge cases.

## Selected foundational behavior

- Use 144 tiles: 136 suited/honor tiles plus four seasons and four flowers.
- Give every physical tile a stable ID from 0 through 143.
- Choose an initial dealer uniformly from the four occupied table positions; that position is East for the hand.
- Use counter-clockwise seat/turn order: East, South, West, North.
- Model the shuffled wall as one linear, two-ended sequence. Ordinary draws use the head; bonus replacements use the tail. Kong replacement behavior remains open.
- Do not simulate dice, physical walls, a break, or East's jumping pickup. The full deterministic shuffle already supplies the random permutation; the documented digital deal is the replay contract.
- Deal three rounds of four-tile packets to each seat, then East two tiles and South/West/North one each.
- After the deal, East, South, West, then North exposes and recursively replaces all bonus tiles. Within a seat, process bonuses in deal-acquisition order and finish each bonus's replacement chain before the next bonus.
- East opens by discarding without drawing. Later turns draw from the head, recursively replace bonuses from the tail, then discard one structural tile.
- Use a modern draw-to-the-end wall with no fixed dead wall. `head > tail` means no future draw is available; an exhaustive draw occurs only when play requires a tile that is unavailable.

These choices are encoded in `hongKongV1Profile` and validated by an exact runtime schema. They are an accepted compatibility contract; semantic fixture changes require `hong-kong/v2`.

## Still intentionally unresolved

Claims, claim priority, multiple winners, kongs, robbing a kong, winning structures, scoring patterns, stacking, fan minimum/cap, payments, dealer continuation, exhaustive-draw consequences, and match length remain open in the [decision register](decision-register.md). No implementation may infer them from the foundational profile.

## Documents

- [Tile set](tile-set.md)
- [Hand lifecycle](hand-lifecycle.md)
- [Worked exhaustive-hand example](worked-examples.md)
- [Rule-to-code traceability](traceability.md)

## Sources and provenance

The [Hong Kong Mahjong Association](https://www.hkmahjong.org/rules?lang=en) publishes one current association ruleset, while common play remains variable. The standard four-packet deal and East's final pickup are illustrated by [Mahjong Multiplayer's Hong Kong dealing guide](https://www.mahjongmultiplayer.app/learn/hong-kong/setup-and-dealing/dealing-the-tiles). General old-Hong-Kong descriptions agree that flowers are exposed and replaced from the back of the wall, but sources differ on dead-wall handling; see the [Old Hong Kong overview](https://en.wikipedia.org/wiki/Mahjong#Old_Hong_Kong_mahjong_rules). The linear wall, stable tile IDs, omitted dice break, and exact exhaustion edge are project engineering choices documented here.
