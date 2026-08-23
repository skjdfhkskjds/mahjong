# `hong-kong/v1` rules decision register

`hong-kong/v1` is the Mahjong Activity project's explicitly selected friend-group profile. It is not presented as the single canonical form of Hong Kong Mahjong.

No game behavior may be implemented from an undocumented default. Each accepted decision must cite its rationale or source and gain worked examples plus traceable fixtures before affected code is complete.

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

All selections are currently open. Milestone gates indicate when each must become accepted.

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

### Flowers and seasons

| ID     | Question            | Candidate choices to evaluate                                         | Required by |
| ------ | ------------------- | --------------------------------------------------------------------- | ----------- |
| HK-010 | Bonus tiles enabled | Always enabled; configurable table profile                            | M0B         |
| HK-011 | Seat matching       | Mapping of flower/season numbers to seats and whether matching scores | M6          |
| HK-012 | Bonus scoring       | Own bonus, no bonuses, complete flower/season set, all eight          | M6          |
| HK-013 | Bonus timing        | Immediate exposure/replacement and any win-on-replacement effects     | M4/M6       |

### Winning structures and eligibility

| ID     | Question               | Candidate choices to evaluate                                       | Required by |
| ------ | ---------------------- | ------------------------------------------------------------------- | ----------- |
| HK-020 | Standard structure     | Four melds plus pair, including exposed/concealed constraints       | M6          |
| HK-021 | Special hands          | Seven pairs, thirteen orphans, nine gates, heavenly/earthly, others | M6          |
| HK-022 | Minimum fan            | Common candidates include 1 or 3 fan; define exceptions             | M6          |
| HK-023 | Chicken hand           | Unsupported; legal exception; named pattern                         | M6          |
| HK-024 | Passed-win restriction | None; temporary same-turn restriction; stronger lockout             | M5          |
| HK-025 | False win              | Reject only; hand penalty; match penalty                            | M6          |

### Claims and reaction windows

| ID     | Question           | Candidate choices to evaluate                                               | Required by |
| ------ | ------------------ | --------------------------------------------------------------------------- | ----------- |
| HK-030 | Priority           | Win over kong/pung over chow; document full ordering                        | M5          |
| HK-031 | Equal-priority tie | Nearest in turn order; other policy                                         | M5          |
| HK-032 | Multiple winners   | All winners; nearest/head-bump; capped number                               | M5          |
| HK-033 | Chow eligibility   | Next seat only and exact sequence constraints                               | M5          |
| HK-034 | Reaction finality  | First response final; replaceable until deadline                            | M5          |
| HK-035 | Early resolution   | Wait for all eligible players; resolve when remaining choices cannot matter | M5          |
| HK-036 | Illegal claim      | Rejection, forced pass, or penalty policy                                   | M5          |

### Kongs and special draws

| ID     | Question             | Candidate choices to evaluate                                | Required by |
| ------ | -------------------- | ------------------------------------------------------------ | ----------- |
| HK-040 | Supported kong forms | Concealed, discard/exposed, and added kong                   | M5          |
| HK-041 | Robbing a kong       | Which kong forms and which hand exceptions may be robbed     | M5          |
| HK-042 | Kong replacement     | Source and ordering relative to bonus replacement            | M5          |
| HK-043 | Kong payments        | Immediate versus only on winning; amounts and dealer effects | M6          |
| HK-044 | Responsibility/pao   | Whether and how liability transfers                          | M6          |

### Scoring patterns

| ID     | Question             | Candidate choices to evaluate                            | Required by |
| ------ | -------------------- | -------------------------------------------------------- | ----------- |
| HK-050 | Pattern catalog      | Exact supported pattern list and fan values              | M6          |
| HK-051 | Concealed definition | Effect of discard win and each exposed meld              | M6          |
| HK-052 | Context bonuses      | Self-draw, last tile, replacement tile, robbed kong      | M6          |
| HK-053 | Pattern interactions | Implication, exclusion, supersession, and stacking graph | M6          |
| HK-054 | Fan cap              | Cap value and whether totals clamp or map to limit tiers | M6          |
| HK-055 | Limit hands          | Values, stacking, and relationship to ordinary cap       | M6          |
| HK-056 | Decomposition choice | Highest legal payment after exclusions and cap           | M6          |

### Payments and balances

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

## Required validation families

Each accepted rule is linked to decision-table tests and worked examples. The suite must also cover physical-tile conservation, replay equivalence, projection noninterference, reaction-order permutations, serialization round trips, deadline boundaries, random legal-game simulation, historical ruleset fixtures, and metamorphic scoring properties.
