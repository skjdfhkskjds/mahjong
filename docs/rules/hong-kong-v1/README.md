# Mahjong Activity Hong Kong profile v1

Status: accepted

Last reviewed: 2026-09-01

This is the project's explicit friend-group Hong Kong Mahjong profile. It is not “the official” or universal Hong Kong ruleset: household, association, tournament, and older Hong Kong conventions disagree on flowers, dead walls, scoring, payments, and edge cases.

## Selected foundational behavior

- Use 144 tiles: 136 suited/honor tiles plus four seasons and four flowers.
- Give every physical tile a stable ID from 0 through 143.
- Choose an initial dealer uniformly from the four occupied table positions; that position is East for the hand.
- Use counter-clockwise seat/turn order: East, South, West, North.
- Model the shuffled wall as one linear, two-ended sequence. Ordinary draws use
  the head; bonus and kong replacements use the tail.
- Do not simulate dice, physical walls, a break, or East's jumping pickup. The full deterministic shuffle already supplies the random permutation; the documented digital deal is the replay contract.
- Deal three rounds of four-tile packets to each seat, then East two tiles and South/West/North one each.
- After the deal, East, South, West, then North exposes and recursively replaces all bonus tiles. Within a seat, process bonuses in deal-acquisition order and finish each bonus's replacement chain before the next bonus.
- East opens by discarding without drawing. Later turns draw from the head, recursively replace bonuses from the tail, then discard one structural tile.
- Use a modern draw-to-the-end wall with no fixed dead wall. `head > tail` means no future draw is available; an exhaustive draw occurs only when play requires a tile that is unavailable.

Claims, all three kong forms, winning structures, scoring, and per-hand payments
are also accepted for implementation. The complete selections and staged
delivery contract are in the
[Milestones 5–6 implementation plan](../../implementation-plans/milestones-5-6.md).
These choices will be encoded in `hongKongV1Profile` and validated by an exact
runtime schema. They are an accepted compatibility contract; semantic fixture
changes require `hong-kong/v2`.

## Selected claims and kongs

- Every discard opens one private-response window. Win outranks pung/exposed
  kong, which outrank chow. Chow is limited to the next seat.
- Responses are final, absent responses pass at eight seconds, and resolution is
  independent of arrival order.
- Exactly one winner is selected by highest capped faan and then nearest turn
  order.
- Concealed, exposed, and added kongs are supported. Only an added kong may be
  robbed. Kong and recursive bonus replacements draw from the v1 wall tail.
- Passing creates no continuing win restriction.

## Selected winning and scoring profile

- Recognize four melds plus a pair, Seven Pairs using seven distinct tile kinds
  with exactly two copies each, and Thirteen Orphans.
- Require three non-bonus eligibility faan.
- Use the finite ordinary, limit, honor, bonus, and winning-condition catalog in
  the decision register and frozen plan; total faan cap at 13.
- Use Half Spicy conversion. A discarder/kong source pays all for a claimed win;
  each loser pays half the table amount on self-pick.
- No dealer multiplier, immediate kong payment, responsibility transfer, or
  false-win payment penalty.

## Still intentionally unresolved

Dealer continuation, round and match progression, running balances,
exhaustive-draw continuation, full post-hand reveal, history retention, and
match length remain open in the [decision register](decision-register.md). No
implementation may infer them from the selected hand-level profile.

## Documents

- [Tile set](tile-set.md)
- [Hand lifecycle](hand-lifecycle.md)
- [Worked exhaustive-hand example](worked-examples.md)
- [Rule-to-code traceability](traceability.md)

## Sources and provenance

The [Hong Kong Mahjong Association](https://www.hkmahjong.org/rules?lang=en) publishes one current association ruleset, while common play remains variable. The standard four-packet deal and East's final pickup are illustrated by [Mahjong Multiplayer's Hong Kong dealing guide](https://www.mahjongmultiplayer.app/learn/hong-kong/setup-and-dealing/dealing-the-tiles). Foundational old-Hong-Kong behavior uses [pinned Mahjong revision 1371716881](https://en.wikipedia.org/w/index.php?title=Mahjong&oldid=1371716881); the accepted scoring catalog uses [pinned Hong Kong scoring revision 1370049011](https://en.wikipedia.org/w/index.php?title=Hong_Kong_mahjong_scoring_rules&oldid=1370049011). Those sources acknowledge variant and table-rule differences, so the explicit project decisions govern every ambiguity. The linear wall, stable tile IDs, omitted dice break, exact exhaustion edge, online deadlines, and selected payment table are project choices documented here.
