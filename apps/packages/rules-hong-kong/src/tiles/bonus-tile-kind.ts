import { seat, type Seat } from "@mahjong/game-core";

export const seasons = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof seasons)[number];

export const flowers = ["plum", "orchid", "chrysanthemum", "bamboo"] as const;
export type Flower = (typeof flowers)[number];

export type BonusTileKind =
  | {
      readonly type: "bonus";
      readonly family: "season";
      readonly name: Season;
      readonly number: 1 | 2 | 3 | 4;
      readonly matchingSeat: Seat;
    }
  | {
      readonly type: "bonus";
      readonly family: "flower";
      readonly name: Flower;
      readonly number: 1 | 2 | 3 | 4;
      readonly matchingSeat: Seat;
    };

export const bonusTileKinds: readonly BonusTileKind[] = [
  {
    type: "bonus",
    family: "season",
    name: "spring",
    number: 1,
    matchingSeat: seat("east"),
  },
  {
    type: "bonus",
    family: "season",
    name: "summer",
    number: 2,
    matchingSeat: seat("south"),
  },
  {
    type: "bonus",
    family: "season",
    name: "autumn",
    number: 3,
    matchingSeat: seat("west"),
  },
  {
    type: "bonus",
    family: "season",
    name: "winter",
    number: 4,
    matchingSeat: seat("north"),
  },
  {
    type: "bonus",
    family: "flower",
    name: "plum",
    number: 1,
    matchingSeat: seat("east"),
  },
  {
    type: "bonus",
    family: "flower",
    name: "orchid",
    number: 2,
    matchingSeat: seat("south"),
  },
  {
    type: "bonus",
    family: "flower",
    name: "chrysanthemum",
    number: 3,
    matchingSeat: seat("west"),
  },
  {
    type: "bonus",
    family: "flower",
    name: "bamboo",
    number: 4,
    matchingSeat: seat("north"),
  },
];
