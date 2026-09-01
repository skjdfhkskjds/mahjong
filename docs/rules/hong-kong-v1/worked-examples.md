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

## Example 2: Claim priority is independent of arrival order

1. East discards one physical circles 5 tile. The tile remains the public
   reaction source while the eight-second window is open.
2. South can chow with circles 3 and 4. West can pung with two concealed circles
   5 tiles. North can legally win for 4 faan using the discard.
3. South responds chow first and West responds pung second. Each valid response
   appends an authority-only `game/reaction-intent-submitted` event, advancing
   canonical game sequence/hash/checkpoint and v2 reaction state. Its private
   acknowledgement does not change public room `stateVersion`, broadcast, or
   disclose the choice.
4. North responds win last, permitting resolution before the deadline. One
   transaction appends the ordered event batch
   `[game/reaction-intent-submitted, game/reaction-resolved]`. The resolution
   event orders the normalized responses South, West, North rather than
   retaining their arrival order; only the resolved transition advances public
   room `stateVersion` and broadcasts.
5. North wins because win outranks pung and chow. East's discarded physical tile
   moves into North's completed hand; no copy remains in East's discard area.
6. The same final event, state, score, and payment result occurs for all six
   arrival permutations of the three responses.

If North passes instead, West's pung wins over South's chow. West exposes the
three exact physical circles 5 tiles, becomes active, and must discard without
an ordinary head draw. If all three pass or time out, South begins an ordinary
draw turn.

## Example 3: Added kong, robbing, and replacement exhaustion

1. South previously exposed a red-dragon pung claimed from East and later draws
   the fourth red dragon.
2. South proposes an added kong. The pung does not become a kong yet; the fourth
   tile remains identifiable as the reaction source.
3. East and North pass. West can legally win using that red dragon and submits
   win. West wins, the exposed pung remains a pung, and the fourth red dragon
   moves from South's concealed hand into West's completed hand. West also
   receives the 1-faan Robbing Kong condition.

In the alternate path where every opponent passes, South's pung becomes an
added kong and South draws from the wall tail. If that tile is a bonus, South
exposes it and continues replacing from the tail. If no structural replacement
is available, the added kong remains committed and the hand ends exhausted
without a winner or payment.

A concealed kong skips the robbing window and commits immediately. An exposed
kong claimed from a discard participates in the ordinary discard window below a
win and above a chow.

## Example 4: Minimum faan, Half Spicy payment, and bonus exclusion

West self-draws a legal all-chow hand with no exposed melds and no bonus tiles:

- Common Hand: 1 eligibility faan.
- Fully Concealed: 1 eligibility faan.
- Self-Pick: 1 eligibility faan.
- No Bonuses: 1 bonus faan, excluded from the minimum.

The hand meets the three-faan minimum before bonuses. Its final total is 4 faan,
which converts to 16 Half Spicy points. On self-pick, East, South, and North each
pay 8; West receives 24. The payment vector sums to zero.

By contrast, a hand with only 2 eligibility faan plus a matching flower is not a
legal win. The matching flower cannot raise it to the three-faan minimum, and
the server does not offer or accept the win action.

## Example 5: Multiple win calls and deterministic scoring

South discards a tile that completes legal hands for West and North. The scorer
evaluates every decomposition before reaction resolution:

- West's best legal interpretation is 5 capped faan.
- North's best legal interpretation is 6 capped faan.

North wins even if West's response arrived first because the higher-faan win has
priority. South pays North the 32 Half Spicy points for 6 faan; East and West
pay zero.

If both candidates score 5 capped faan, West wins because West is encountered
before North when moving in normal turn order after South. Losing win intentions
and their scores remain authority-only and are not projected to any client.

## Example 6: Supersession and score explanation

A winning hand contains two dragon melds, a pair of the third dragon, and enough
tiles from one suit to satisfy Mixed One Suit. Detection records Small Dragons,
the two individual dragon melds, and Mixed One Suit. Awarding produces:

- Small Dragons: 5 faan, suppressing the two individual dragon awards.
- Mixed One Suit: 3 faan.

The hand therefore has 8 hand/honor faan before winning conditions and bonuses,
not 10. The explanation retains the suppressed dragon facts and names Small
Dragons as the reason, so the awarded faan and payment can be reproduced without
re-running an opaque prose rule.
