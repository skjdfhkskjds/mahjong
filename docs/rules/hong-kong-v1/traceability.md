# Hong Kong v1 rule traceability

| Decision       | Executable contract                                                               | Verification                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HK-001, HK-010 | `hongKongV1Profile.tileSet`; `createHongKongV1TileSet`                            | accepted-profile round trip in `hong-kong-profile.test.ts`; 144-tile identity and boundary fixtures in `create-tile-set.test.ts`                                    |
| HK-011         | `bonusTileKinds`                                                                  | exact season/flower ID fixtures in `create-tile-set.test.ts`; public bonus projection in `draw-discard-game.test.ts`                                                |
| HK-002         | `HONG_KONG_V1_SHUFFLE_ALGORITHM`; `deterministicShuffle`                          | complete fixed physical-ID vector, byte sensitivity, permutation, and input-length fixtures in `deterministic-shuffle.test.ts`                                      |
| HK-003         | `initialDealSeatOrder`; `startHongKongV1Game`                                     | packet-order fixture in `initial-deal.test.ts`; post-replacement structural-hand counts in `draw-discard-game.test.ts`; Worked Example 1                            |
| HK-004–HK-006  | `hongKongV1Profile.wall`; `deterministicShuffle`; `applyGameCommand`              | accepted-profile round trip, fixed shuffle vector, multi-game exhaustion simulation, recursive replacement fixture, and 144-tile invariant checks                   |
| HK-007, HK-013 | `hongKongV1Profile.bonusReplacement`; `startHongKongV1Game`; `applyGameCommand`   | public initial bonuses, forced three-bonus ordinary replacement chain, multi-game conservation simulation, and Worked Example 1                                     |
| HK-008         | `hongKongV1Profile.ordinaryTurn`; `applyGameCommand`; `replayGameEvents`          | phase/actor/tile rejection fixtures, multi-game draw/discard simulation through exhaustion, canonical round trip, forged-transition rejection, and Worked Example 1 |
| HK-009         | `hongKongV1Profile.seating`; `selectInitialDealerPosition`; `startHongKongV1Game` | fixed dealer-selection vector, four-seat hand fixture, turn-order simulation, and Worked Example 1                                                                  |

Milestone 4 replaces the foundational prose-only lifecycle evidence with
permanent engine fixtures. The accepted Milestone 5–6 scoring decisions below
must map to positive, near-miss, interaction, and payment fixtures before their
roadmap milestones become complete.

## Frozen Milestone 5 fixture plan

These contracts are accepted but remain planned until their named fixtures are
implemented and the roadmap records passing evidence.

| Decision           | Planned executable contract                                      | Required fixture families                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HK-024, HK-034–036 | canonical authority-only response events and validation          | private event advances sequence/hash/checkpoint but not public version; final intent+resolution batch; first valid final; invalid retry; timeout                                                            |
| HK-030–HK-033      | `calculateLegalReactions`; normalized reaction resolver          | all arrival permutations; win/pung/chow priority; exact chow variants; next-seat restriction; highest-faan/nearest                                                                                          |
| HK-040             | meld model and concealed/exposed/added kong transitions          | every kong form; exact physical IDs; immutable public melds                                                                                                                                                 |
| HK-041             | added-kong reaction resolver                                     | legal rob; pass commits kong; concealed/exposed kong cannot be robbed                                                                                                                                       |
| HK-042, HK-071     | kong/bonus tail replacement and exhaustion                       | chained bonus replacement; final structural replacement; failed replacement after committed kong                                                                                                            |
| TP-001–TP-003      | persisted deadline queue and explicit idempotent system commands | 60-second turn versus 15-second grace; before/at/after boundary; duplicate alarm; valid-socket presence; reconnect generation cancellation; immediate draw/replacement/discard or pass; never auto win/kong |
| TP-007             | room abandonment system command                                  | table-wide zero-valid-socket absence; seated reconnect recovery; retained canonical history; no deletion or fake exhaustion                                                                                 |

Worked Examples 2 and 3 are the narrative fixtures for claim priority, kong
robbing, and replacement exhaustion.

## Frozen Milestone 6 fixture plan

| Decision      | Planned executable contract                              | Required fixture families                                                                                                         |
| ------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| HK-020–HK-023 | standard decomposition plus Seven Pairs/Thirteen Orphans | positive, near-miss, declared-meld constraints, seven distinct pairs, four-copy duplicate-kind rejection, subminimum chicken hand |
| HK-025        | authoritative legal-win actions                          | forged self/reaction win rejected without public transition or penalty                                                            |
| HK-012        | bonus pattern detection and minimum split                | no/matching/all bonuses; family supersession; bonuses cannot meet minimum; no instant bonus win                                   |
| HK-050        | stable pattern catalog and detector                      | positive and one-tile near-miss for every accepted pattern                                                                        |
| HK-051–HK-053 | detected/awarded split and validated interaction graph   | concealed-kong exposure; every implication/exclusion/supersession edge; graph validation                                          |
| HK-054–HK-055 | 13-faan cap and highest-limit selection                  | 10-faan limit plus conditions; 13-faan cap; overlapping equal/different limits                                                    |
| HK-056        | exhaustive decomposition and best-score selection        | ambiguous hand with lower and higher interpretations; stable equal-score encoding tie                                             |
| HK-060        | Half Spicy conversion                                    | exact table entries from 3 through 13 faan                                                                                        |
| HK-061–HK-063 | pure zero-sum payment calculator                         | discard, robbing, self-pick, no dealer multiplier, seat-rotation metamorphism                                                     |
| HK-031–HK-032 | scorer-backed single-winner resolver                     | different-faan calls, equal-faan nearest tie, losing-intent privacy                                                               |

Worked Examples 4–6 cover bonus-excluded eligibility, Half Spicy self-pick and
discard payments, multi-win selection, and dragon supersession. The compact
scoring DSL must record physical IDs, declared meld history, winning source,
seat/prevailing winds, bonuses, wall position, kong chain, expected detected and
awarded patterns, and expected payments.

Cross-cutting fixtures additionally prove canonical state-v1 to state-v2 event
upgrade, byte-equivalent replay, all-144-tile conservation, private projection
noninterference, canonical private-intent recovery, strict protocol-v2 decoding
with v1 rejection, atomic hashed-asset rollout/rollback, and TableRoom storage
v1/v3 to v4 migration.
