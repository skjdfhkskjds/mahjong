# Foundational rule traceability

| Decision       | Executable contract                  | Verification                                               |
| -------------- | ------------------------------------ | ---------------------------------------------------------- |
| HK-001, HK-010 | `hongKongV1Profile.tileSet`          | `hong-kong-profile.test.ts`                                |
| HK-011         | `bonusTileKinds`                     | exact bonus ID fixtures in `create-tile-set.test.ts`       |
| HK-002         | `createHongKongV1TileSet`            | exact ID boundary fixtures in `create-tile-set.test.ts`    |
| HK-003         | `initialDealSeatOrder`               | packet order and per-seat counts in `initial-deal.test.ts` |
| HK-004–HK-006  | `hongKongV1Profile.wall`             | strict profile parse and JSON round trip                   |
| HK-007, HK-013 | `hongKongV1Profile.bonusReplacement` | strict profile parse; Worked Example 1                     |
| HK-008         | `hongKongV1Profile.ordinaryTurn`     | strict profile parse; Worked Example 1                     |
| HK-009         | `hongKongV1Profile.seating`          | strict profile parse; Worked Example 1                     |

Future milestones replace prose-only evidence with engine fixtures when the corresponding behavior is implemented. Every scoring decision must eventually map to positive, near-miss, interaction, and payment fixtures where applicable.
