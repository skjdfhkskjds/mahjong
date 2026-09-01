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
permanent engine fixtures. Milestones 5–6 add the executable contracts below;
their permanent positive, near-miss, interaction, payment, privacy, replay, and
migration fixtures are required compatibility evidence.

## Milestone 5 executable evidence

| Decision           | Executable contract                                              | Verification                                                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HK-024, HK-034–036 | canonical authority-only response events and validation          | `stage2-evidence.test.ts`, `table-room-authority-persistence.test.ts`, and `table-room.test.ts`: private event advances sequence/hash/checkpoint but not public version; final intent+resolution batch; first valid final; invalid retry; timeout; viewer-safe recovery across eviction/reconnect |
| HK-030–HK-033      | `calculateLegalReactions`; normalized reaction resolver          | `claims-kongs.test.ts`, `stage2-evidence.test.ts`, and `win-resolution.test.ts`: arrival permutations; win/pung/chow priority; exact chow variants; next-seat restriction; highest-faan/nearest winner selection                                                                                  |
| HK-040             | meld model and concealed/exposed/added kong transitions          | `claims-kongs.test.ts` and strict protocol/client fixtures: every kong form, exact physical IDs, immutable public melds, exact action commands                                                                                                                                                    |
| HK-041             | added-kong reaction resolver                                     | `claims-kongs.test.ts` and `win-resolution.test.ts`: legal suited-tile rob; pass commits kong; robbed provenance/payments; concealed/exposed kong cannot be robbed                                                                                                                                |
| HK-042, HK-071     | kong/bonus tail replacement and exhaustion                       | `claims-kongs.test.ts` and `stage2-evidence.test.ts`: chained kong, recursive bonus replacement, final structural replacement, failed replacement after committed kong, 144-tile conservation, replay                                                                                             |
| TP-001–TP-003      | persisted deadline queue and explicit idempotent system commands | `table-room-deadline-queue.test.ts` and `table-room.test.ts`: 60-second turn versus 15-second grace; before/at/after boundary; duplicate/late alarm; reconnect generation cancellation; constructor repair; immediate deterministic action or pass; never automatic win/kong                      |
| TP-007             | recoverable room abandonment command                             | `table-room.test.ts`: table-wide zero-valid-socket absence, stable generation, seated reconnect recovery, retained canonical history, no deletion or fake exhaustion                                                                                                                              |

Worked Examples 2 and 3 are the narrative fixtures for claim priority, kong
robbing, and replacement exhaustion.

## Milestone 6 executable evidence

| Decision      | Executable contract                                      | Verification                                                                                                                                                                                |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HK-020–HK-023 | standard decomposition plus Seven Pairs/Thirteen Orphans | `decompose-hand.test.ts`: canonical exhaustive decomposition, near misses, declared-meld constraints, seven distinct pairs, four-copy duplicate-kind rejection, invalid physical provenance |
| HK-025        | authoritative legal-win actions                          | `win-resolution.test.ts` and `table-room.test.ts`: low-faan/false/forged self and reaction wins rejected without public transition or penalty                                               |
| HK-012        | bonus pattern detection and minimum split                | `detect-patterns.test.ts` and `score-hand.test.ts`: no/matching/all bonuses, family supersession, bonuses cannot meet minimum, no instant bonus win                                         |
| HK-050        | stable pattern catalog and detector                      | `detect-patterns.test.ts`: independently pinned IDs/categories/faan with positive and one-tile near-miss fixtures for every accepted pattern                                                |
| HK-051–HK-053 | detected/awarded split and validated interaction graph   | `score-hand.test.ts`: concealed-kong exposure, every implication/exclusion/supersession edge, graph acyclicity, stable explanations                                                         |
| HK-054–HK-055 | 13-faan cap and highest-limit selection                  | `score-hand.test.ts`: 10-faan limit plus conditions, 13-faan cap, overlapping equal/different limits                                                                                        |
| HK-056        | exhaustive decomposition and best-score selection        | `decompose-hand.test.ts` and `score-hand.test.ts`: ambiguous lower/higher interpretations and stable equal-score pattern/encoding tie                                                       |
| HK-060        | Half Spicy conversion                                    | `score-hand.test.ts`: exact conversion entries from 3 through 13 faan                                                                                                                       |
| HK-061–HK-063 | pure zero-sum payment calculator                         | `score-hand.test.ts` and `win-resolution.test.ts`: discard, suited-tile robbing, self-pick, no dealer multiplier, exact explanations, seat rotation                                         |
| HK-031–HK-032 | scorer-backed single-winner resolver                     | `win-resolution.test.ts`: different-faan calls, equal-faan nearest tie, submission-order independence, losing-intent privacy                                                                |

Worked Examples 4–6 cover bonus-excluded eligibility, Half Spicy self-pick and
discard payments, multi-win selection, and dragon supersession. The compact
scoring DSL records physical IDs, declared meld history, winning source,
seat/prevailing winds, bonuses, wall position, kong chain, expected detected and
awarded patterns, and expected payments.

Cross-cutting fixtures additionally prove canonical state-v1 to state-v2 event
upgrade, byte-equivalent replay, all-144-tile conservation, private projection
noninterference, canonical private-intent recovery, strict protocol-v2 decoding
with v1 rejection, atomic hashed-asset rollout/rollback, and TableRoom storage
v1/v3 to v4 migration.
