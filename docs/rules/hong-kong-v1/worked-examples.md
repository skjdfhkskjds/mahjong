# Worked examples

## Example 1: Deal, chained bonuses, ordinary play, and exhaustion

This symbolic example identifies behavior without prescribing a full shuffle vector. Each named tile represents one unique physical tile ID.

Milestone 4 makes this lifecycle executable. The fixed shuffle vector is kept separately so this example can remain readable, while the engine fixtures exercise the same deal, recursive bonus replacement, dealer opening discard, ordinary head draw, tail replacement, and exhaustion boundary.

1. The room assigns players A/B/C/D to East/South/West/North. A is dealer.
2. The server shuffles all 144 physical IDs and sets `head = 0`, `tail = 143`.
3. The 53-step deal runs exactly as documented. In acquisition order, East's 14 slots include Spring and then Plum. West's 13 slots include Orchid. South and North receive only structural tiles.
4. Initial replacement begins with East:
   - East exposes Spring.
   - East draws the tail tile, Winter. Because it is another bonus, East exposes it too.
   - East draws again from the tail and receives bamboo 5, reaching 14 structural tiles.
   - East then processes its second originally dealt bonus, Plum.
   - East exposes Plum and draws green dragon from the tail, restoring 14 structural tiles again.
5. South has no bonus, so no replacement occurs.
6. West exposes Orchid and draws circles 7 from the tail, reaching 13 structural tiles.
7. North has no bonus. Initial replacement is complete.
8. East discards characters 9. For this example, no claim is submitted.
9. South draws from the head and receives Orchid. South exposes it, draws red dragon from the tail, then discards circles 2.
10. Play continues with every unclaimed discard advancing to the next seat. Each ordinary structural draw changes 13 structural tiles to 14; each discard restores 13.
11. Near the end, exactly one wall tile remains (`head === tail`) when North begins a turn. It is Autumn.
12. North draws and exposes Autumn, consuming the final wall tile. A replacement is required, but now `head > tail`, so none exists.
13. The hand ends as an exhaustive draw without North discarding. Payments, dealer continuation, and concealed-hand reveal behavior remain unresolved and therefore are not inferred by this example.

If the final wall tile in step 11 had instead been structural, North's draw would succeed. North would still receive the later-defined self-action opportunity and, absent a hand-ending action, discard normally. The empty wall alone would not retroactively turn that successful draw into an exhaustive draw; exhaustion would occur only when later play required another unavailable tile.

Invariant checks throughout:

- Every physical ID moves from exactly one location to exactly one new location.
- Bonuses move to public bonus ownership and never enter concealed structural hands.
- Head draws and tail replacements never consume the same tile.
- East has 14 structural tiles before the opening discard; ordinary active players have 14 before later discards; inactive players have 13.

Executable correspondence:

- `deterministic-shuffle.test.ts` fixes the complete shuffled physical-ID order and selected dealer for a published random-byte stream.
- `draw-discard-game.test.ts` verifies the four private post-replacement hands, forces an ordinary draw through three recursive tail replacements, and runs multiple seeded games through the step 11–13 exhaustion boundary.
- The same engine fixture checks all 144 physical IDs after every accepted event and replays the event stream to byte-equivalent canonical state.
