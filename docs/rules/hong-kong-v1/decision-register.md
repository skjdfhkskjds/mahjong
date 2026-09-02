# `hong-kong/v1` rules decision register

`hong-kong/v1` is the Mahjong Activity project's explicitly selected friend-group profile. It is not presented as the single canonical form of Hong Kong Mahjong.

No game behavior may be implemented from an undocumented default. Each selected decision must cite its rationale or source and gain worked examples plus traceable fixtures before affected code is complete.

## Status and change policy

- `open`: candidates are still being researched or discussed.
- `provisional`: selected for planning, but not yet accepted as a compatibility promise.
- `accepted`: implementation and historical fixtures may depend on it.

Changing an accepted semantic outcome requires a new ruleset version. Editorial clarification with identical fixture outcomes does not.

Each decision should ultimately record:

```text
id, question, candidates, selection, status, required-by,
rationale/provenance, compatibility impact, worked examples, fixture IDs
```

## Decision inventory

Foundational setup, draw/discard, claim, kong, winning, scoring, and per-hand
payment selections are accepted for `hong-kong/v1`. Match progression and
running-balance decisions remain open. The accepted Milestone 5–6 behavior and
implementation boundaries are frozen in the
[Milestones 5–6 implementation plan](../../implementation-plans/milestones-5-6.md).

### Accepted foundational selections

| ID     | Selection                                                                                                                                   | Rationale/provenance                                                                          | Compatibility impact |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| HK-001 | 144 tiles: 108 suited, 28 honors, four seasons, four flowers                                                                                | Common full Hong Kong set; intentionally chooses bonuses over the also-common 136-tile option | Tile inventory       |
| HK-002 | IDs 0–107 suits, 108–123 winds, 124–135 dragons, 136–139 seasons, 140–143 flowers; four-copy kinds order copy 0–3                           | Engineering convention required for deterministic vectors                                     | Encoding/shuffle     |
| HK-003 | Three East/South/West/North four-tile packet rounds, then East, East, South, West, North                                                    | Preserves the common packet deal and East's 14-tile opening hand in a linear digital wall     | Deal/replay          |
| HK-004 | Fully shuffled linear wall; no simulated dice, physical sides, break, or jump pickup                                                        | Physical randomization rituals are redundant after a committed deterministic shuffle          | Replay/UI            |
| HK-005 | No fixed dead wall; ordinary draws consume the head and bonus replacements consume the tail                                                 | Chooses modern draw-to-the-end play rather than older reserved-dead-wall conventions          | Wall/exhaustion      |
| HK-006 | Head passing tail means no future draw; exhaustion occurs when play requires an unavailable ordinary or bonus-replacement draw              | Makes two-ended consumption precise and preserves a successful final structural draw          | Hand lifecycle       |
| HK-007 | Initial replacement order East/South/West/North; within a seat use deal-acquisition order and complete each recursive chain before the next | Selects one documented table convention where replacement ordering varies                     | Deal/projection      |
| HK-008 | East opens with a discard; ordinary turns draw at head, recursively replace bonuses at tail, then discard exactly one structural tile       | Defines the minimal playable cycle while leaving claims and wins gated                        | Turn engine          |
| HK-009 | Choose an occupied table position uniformly for the initial dealer, assign it East, then assign South/West/North counter-clockwise          | Keeps stable room position distinct from rotating seat wind                                   | Match setup          |
| HK-010 | All eight bonus tiles enabled                                                                                                               | Makes v1 concrete; a no-bonus game would be a distinct preset/version                         | Tile inventory       |
| HK-011 | Number/seat mapping is East=1, South=2, West=3, North=4 for both seasons and flowers                                                        | Common mapping used to give the unique bonus tiles stable semantic identity                   | Tile identity        |
| HK-013 | Expose bonuses immediately and recursively replace them from the tail; accepted matching-seat and replacement-win scoring is applied later  | Common Hong Kong handling; deliberately separates lifecycle from later scoring                | Hand/scoring         |

All selections in this table have status `accepted` as of Milestone 4. Lobby
seats are stable table positions; HK-009 is applied when a hand starts by
uniformly selecting one position as East and rotating the remaining positions
onto South, West, and North in table order.

### Accepted claims, kongs, and exhaustion selections

| ID     | Selection                                                                                                                                                   | Rationale/provenance                                                                                          | Compatibility impact |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------- |
| HK-024 | Passing applies only to the current window; there is no continuing passed-win or furiten-style restriction                                                  | The pinned Old Hong Kong description imposes no continuing restriction; v1 selects the simplest explicit rule | Win eligibility      |
| HK-030 | Win outranks pung/exposed kong, which are equal, and both outrank chow                                                                                      | Pinned Mahjong revision 1371716881                                                                            | Claim resolution     |
| HK-031 | Among legal win calls, highest capped total faan wins; equal faan goes to the nearest seat in normal turn order after the source                            | Pinned Mahjong revision 1371716881                                                                            | Winner selection     |
| HK-032 | Exactly one winner                                                                                                                                          | Old Hong Kong single-winner convention                                                                        | Result/payments      |
| HK-033 | Only the next seat may chow; a chow is an exact three-kind suited sequence                                                                                  | Pinned Mahjong revision 1371716881                                                                            | Legal actions        |
| HK-034 | A seat's first valid response is final                                                                                                                      | Digital table policy preserves declaration finality and simple idempotency                                    | Protocol/persistence |
| HK-035 | Resolve when all three non-source seats respond or at eight seconds; missing responses become pass; arrival order never affects the result                  | Explicit online timing and privacy policy                                                                     | Timing/protocol      |
| HK-036 | Reject an illegal claim without consuming the seat's opportunity to submit another valid response before the deadline                                       | Server-authoritative safety; penalties are not inferred                                                       | Validation           |
| HK-040 | Support concealed, discard/exposed, and added kongs                                                                                                         | Pinned Mahjong revision 1371716881                                                                            | Meld state           |
| HK-041 | Only an added kong may be robbed, and any legal winning hand may use its proposed fourth tile                                                               | Pinned Mahjong revision 1371716881                                                                            | Kong/win resolution  |
| HK-042 | Kong replacements use the v1 wall tail and recursively replace bonuses; a committed kong remains formed if its required replacement exhausts the wall       | Reconciles the pinned kong rule with accepted HK-005–006 linear-wall semantics                                | Wall/exhaustion      |
| HK-043 | No immediate kong payment                                                                                                                                   | The selected modern scoring table settles only a winning hand                                                 | Payments             |
| HK-044 | No responsibility/pao transfer                                                                                                                              | The cited responsibility examples belong to an unselected payment variant                                     | Payments             |
| HK-071 | An unavailable required ordinary, bonus, or kong-replacement draw ends the hand without a winner or hand payment; later dealer/round consequences remain M7 | Extends accepted HK-006 without deciding match progression                                                    | Hand terminal state  |

### Accepted winning and scoring selections

| ID     | Selection                                                                                                                                                                                                                 | Rationale/provenance                                                                                     | Compatibility impact |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------- |
| HK-012 | Award 1 for no bonuses, 1 for the matching flower, 1 for the matching season, 2 for all flowers, and 2 for all seasons; complete-family awards suppress their matching-tile award; no instant seven/eight-bonus win       | Pinned scoring revision 1370049011 plus explicit exclusion of its custom instant-win option              | Bonus scoring        |
| HK-020 | Standard structure is four melds plus one pair; a declared kong has structural size three                                                                                                                                 | Pinned scoring revision 1370049011 and ordinary Mahjong structure                                        | Recognition          |
| HK-021 | Enable Seven Pairs and Thirteen Orphans as the only nonstandard structures; Seven Pairs requires seven distinct kinds with exactly two copies each, so four copies cannot count twice; declared melds may not participate | The pinned scoring catalog lists both; v1 resolves its duplicate-kind and kong ambiguity explicitly      | Recognition          |
| HK-022 | Require 3 eligibility faan from hand, wind/dragon, and winning-condition categories; bonus-category faan never meet the minimum                                                                                           | Pinned revisions 1370049011 and 1371716881                                                               | Win legality         |
| HK-023 | A chicken/zero-faan or otherwise subminimum hand is not a legal win                                                                                                                                                       | Consequence of HK-022                                                                                    | Win legality         |
| HK-025 | Reject forged or illegal win commands without a score penalty; the server never broadcasts an invalid declaration                                                                                                         | Server-authoritative project choice                                                                      | Validation/payments  |
| HK-050 | Use the finite pattern catalog in the frozen plan: nine ordinary/special hand patterns, seven limit patterns, wind/dragon/bonus awards, and eight winning-condition patterns                                              | Pinned scoring revision 1370049011                                                                       | Score semantics      |
| HK-051 | A concealed kong remains concealed; an exposed chow/pung/kong opens the hand; a discard may complete an otherwise fully concealed hand                                                                                    | Pinned scoring revision 1370049011                                                                       | Pattern detection    |
| HK-052 | Award the selected self-pick, fully concealed, robbing, last-catch, replacement, double-kong, Heavenly, and Earthly conditions with the exact suppressions in the frozen plan                                             | Pinned scoring revision 1370049011 plus explicit ambiguity resolution                                    | Score context        |
| HK-053 | Stack ordinary criteria unless an explicit exclusion applies; dragon totals suppress individual dragons; limits select only the highest limit; the full graph is defined in the frozen plan                               | Resolves contradictions in the pinned scoring article                                                    | Score interactions   |
| HK-054 | Cap total faan at 13                                                                                                                                                                                                      | Pinned scoring revision 1370049011                                                                       | Score conversion     |
| HK-055 | Limits are All Honors/Four Concealed Triplets/Terminals Only/Nine Gates at 10 and Great Winds/Four Kongs/Thirteen Orphans at 13                                                                                           | Pinned scoring revision 1370049011                                                                       | Limit scores         |
| HK-056 | Enumerate every decomposition and select the highest legal score; deterministic canonical ordering breaks equal-score encoding ties                                                                                       | Required for explainable deterministic replay                                                            | Decomposition        |
| HK-060 | Use the Half Spicy table `3→8, 4→16, 5→24, 6→32, 7→48, 8→64, 9→96, 10→128, 11→192, 12→256, 13→384`                                                                                                                        | One of the two modern tables in pinned scoring revision 1370049011; selected to bound private-alpha play | Payments             |
| HK-061 | On discard or robbing-kong wins, the source seat pays all table points                                                                                                                                                    | Selected discarder-pays-all option from pinned scoring revision 1370049011                               | Payments             |
| HK-062 | On self-pick, each loser pays half the table amount and the winner receives one and a half times it                                                                                                                       | Pinned scoring revision 1370049011                                                                       | Payments             |
| HK-063 | No dealer payment multiplier                                                                                                                                                                                              | The selected modern table does not specify one; dealer progression remains M7                            | Payments             |

All selections in these two tables have status `accepted` as of 2026-09-01.
Their pinned sources are
[Mahjong revision 1371716881](https://en.wikipedia.org/w/index.php?title=Mahjong&oldid=1371716881)
and
[Hong Kong scoring revision 1370049011](https://en.wikipedia.org/w/index.php?title=Hong_Kong_mahjong_scoring_rules&oldid=1370049011).
Where those sources conflict or enumerate house alternatives, the project
selection in this register is authoritative for `hong-kong/v1`.

Traceability is recorded in [traceability.md](traceability.md), with the complete accepted behavior in the [profile README](README.md).

### Tile set, setup, and wall

| ID     | Question                   | Candidate choices to evaluate                                      | Required by |
| ------ | -------------------------- | ------------------------------------------------------------------ | ----------- |
| HK-001 | Exact tile composition     | 136 tiles; 144 with four flowers and four seasons; other named set | M0B         |
| HK-002 | Physical tile ordering     | Canonical IDs and copy order for deterministic fixtures            | M0B         |
| HK-003 | Dealer initial hand        | Exact deal packets, dealer's 14th tile, first discard sequence     | M0B         |
| HK-004 | Wall break                 | Dice/break simulation versus abstract deterministic wall start     | M4          |
| HK-005 | Live/dead/replacement wall | Whether a dead wall exists; draw directions and counts             | M4          |
| HK-006 | Exhaustion boundary        | Exact point at which no normal or replacement draw remains         | M4          |
| HK-007 | Initial bonus replacement  | Seat order, within-seat ordering, chaining, and exhaustion         | M4          |
| HK-008 | Ordinary draw/discard      | Draw source, bonus recursion, discard count, and seat advance      | M0B         |
| HK-009 | Initial dealer/seats       | Dealer selection and stable-position-to-seat assignment            | M0B         |

### Flowers and seasons

| ID     | Question            | Candidate choices to evaluate                                            | Required by |
| ------ | ------------------- | ------------------------------------------------------------------------ | ----------- |
| HK-010 | Bonus tiles enabled | Always enabled; configurable table profile                               | M0B         |
| HK-011 | Seat matching       | Mapping of flower/season numbers to seats                                | M0B         |
| HK-012 | Bonus scoring       | Whether matching scores; own bonus, no bonuses, complete sets, all eight | M6          |
| HK-013 | Bonus timing        | Immediate exposure/replacement and any win-on-replacement effects        | M4/M6       |

### Winning structures and eligibility inventory

| ID     | Question               | Candidate choices to evaluate                                       | Required by |
| ------ | ---------------------- | ------------------------------------------------------------------- | ----------- |
| HK-020 | Standard structure     | Four melds plus pair, including exposed/concealed constraints       | M6          |
| HK-021 | Special hands          | Seven pairs, thirteen orphans, nine gates, heavenly/earthly, others | M6          |
| HK-022 | Minimum fan            | Common candidates include 1 or 3 fan; define exceptions             | M6          |
| HK-023 | Chicken hand           | Unsupported; legal exception; named pattern                         | M6          |
| HK-024 | Passed-win restriction | None; temporary same-turn restriction; stronger lockout             | M5          |
| HK-025 | False win              | Reject only; hand penalty; match penalty                            | M6          |

### Claims and reaction windows inventory

| ID     | Question           | Candidate choices to evaluate                                               | Required by |
| ------ | ------------------ | --------------------------------------------------------------------------- | ----------- |
| HK-030 | Priority           | Win over kong/pung over chow; document full ordering                        | M5          |
| HK-031 | Equal-priority tie | Nearest in turn order; other policy                                         | M5          |
| HK-032 | Multiple winners   | All winners; nearest/head-bump; capped number                               | M5          |
| HK-033 | Chow eligibility   | Next seat only and exact sequence constraints                               | M5          |
| HK-034 | Reaction finality  | First response final; replaceable until deadline                            | M5          |
| HK-035 | Early resolution   | Wait for all eligible players; resolve when remaining choices cannot matter | M5          |
| HK-036 | Illegal claim      | Rejection, forced pass, or penalty policy                                   | M5          |

### Kongs and special draws inventory

| ID     | Question             | Candidate choices to evaluate                                | Required by |
| ------ | -------------------- | ------------------------------------------------------------ | ----------- |
| HK-040 | Supported kong forms | Concealed, discard/exposed, and added kong                   | M5          |
| HK-041 | Robbing a kong       | Which kong forms and which hand exceptions may be robbed     | M5          |
| HK-042 | Kong replacement     | Source and ordering relative to bonus replacement            | M5          |
| HK-043 | Kong payments        | Immediate versus only on winning; amounts and dealer effects | M6          |
| HK-044 | Responsibility/pao   | Whether and how liability transfers                          | M6          |

### Scoring patterns inventory

| ID     | Question             | Candidate choices to evaluate                            | Required by |
| ------ | -------------------- | -------------------------------------------------------- | ----------- |
| HK-050 | Pattern catalog      | Exact supported pattern list and fan values              | M6          |
| HK-051 | Concealed definition | Effect of discard win and each exposed meld              | M6          |
| HK-052 | Context bonuses      | Self-draw, last tile, replacement tile, robbed kong      | M6          |
| HK-053 | Pattern interactions | Implication, exclusion, supersession, and stacking graph | M6          |
| HK-054 | Fan cap              | Cap value and whether totals clamp or map to limit tiers | M6          |
| HK-055 | Limit hands          | Values, stacking, and relationship to ordinary cap       | M6          |
| HK-056 | Decomposition choice | Highest legal payment after exclusions and cap           | M6          |

### Payments and balances inventory

| ID     | Question                  | Candidate choices to evaluate                         | Required by |
| ------ | ------------------------- | ----------------------------------------------------- | ----------- |
| HK-060 | Payment formula           | Base-unit/exponential table and rounding              | M6          |
| HK-061 | Discard win               | Discarder pays all; all losers pay; hybrid            | M6          |
| HK-062 | Self draw                 | All losers pay and whether self-draw itself adds fan  | M6          |
| HK-063 | Dealer effect             | Winner multiplier, payer multiplier, both, or neither | M6          |
| HK-064 | Starting/negative balance | Starting units, bankruptcy, negative scores           | M7          |

### Dealer, hands, rounds, and match

| ID     | Question                | Candidate choices to evaluate                              | Required by |
| ------ | ----------------------- | ---------------------------------------------------------- | ----------- |
| HK-070 | Dealer continuation     | After dealer win, non-dealer win, exhaustive draw          | M7          |
| HK-071 | Exhaustive draw         | Dealer effect, payments, reveal behavior                   | M5/M7       |
| HK-072 | Match length            | East-only, East/South, fixed hands, configurable           | M7          |
| HK-073 | Termination             | End-of-round, target balance, bankruptcy, overtime         | M7          |
| HK-074 | Hand history visibility | Concealed reveal and spectator visibility after completion | M7          |

## Operational table policy (versioned separately)

These choices affect deterministic play but are not inherently Hong Kong scoring semantics:

| ID     | Question                                      | Required by |
| ------ | --------------------------------------------- | ----------- |
| TP-001 | Turn duration and warning schedule            | M5          |
| TP-002 | Reaction duration and timeout default         | M5          |
| TP-003 | Disconnect grace and seated-player automation | M3/M5       |
| TP-004 | Seat reservation and reclaim policy           | M3          |
| TP-005 | Spectator admission and post-hand reveal      | M3/M7       |
| TP-006 | Table owner/host powers                       | M2          |
| TP-007 | Abandonment, retention, archive, and deletion | M7          |
| TP-008 | Missing entropy contribution abort/fallback   | M8          |

Accepted Milestone 5 operational policy:

- TP-001: 60 seconds for each connected draw or discard decision. In
  `awaiting-draw`, timeout atomically draws, recursively replaces bonuses, and
  discards the last-acquired structural tile. In `awaiting-discard`, it
  discards the last-acquired remaining tile or lowest canonical physical ID.
- TP-002: eight seconds per reaction window; no response is pass.
- TP-003: after an actor has no currently valid socket for 15 seconds, mark the
  actor autopilot through the canonical/system pipeline and immediately perform
  actionable deterministic work. Future autopilot turns act immediately and
  reactions pass; it never wins or kongs. A valid seated reconnect
  generation-cancels the grace and clears autopilot.
- TP-007 (hand-level portion only): after the table has no currently valid
  socket for 15 minutes, mark the room/hand recoverably abandoned and retain all
  storage. A valid seated reconnect clears abandonment and resumes. Cleanup,
  archive, and deletion remain open for M7. Stored grants alone are not
  presence.

## Required validation families

Each accepted rule is linked to decision-table tests and worked examples. The suite must also cover physical-tile conservation, replay equivalence, projection noninterference, reaction-order permutations, serialization round trips, deadline boundaries, random legal-game simulation, historical ruleset fixtures, and metamorphic scoring properties.
