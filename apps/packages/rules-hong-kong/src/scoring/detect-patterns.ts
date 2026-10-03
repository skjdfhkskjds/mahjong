import type { StandardTileKind, TileId } from "@mahjong/game-core";

import { tileKind } from "../tiles/tile-kind-identity.js";
import type { HandDecomposition, ScoringMeld } from "./decompose-hand.js";
import type { ScoringHandFixture } from "./hand-fixture.js";

export type PatternCategory =
  "bonus" | "hand" | "limit" | "value-honor" | "winning-condition";

export type PatternId =
  | "all-honors"
  | "all-one-suit"
  | "all-seasons"
  | "all-flowers"
  | "all-triplets"
  | "common-hand"
  | "double-kong-win"
  | "earthly-hand"
  | "four-concealed-triplets"
  | "four-kongs"
  | "fully-concealed"
  | "great-dragons"
  | "great-winds"
  | "green-dragon"
  | "heavenly-hand"
  | "last-catch"
  | "matching-flower"
  | "matching-season"
  | "mixed-one-suit"
  | "mixed-orphans"
  | "nine-gates"
  | "no-bonuses"
  | "prevailing-wind"
  | "red-dragon"
  | "replacement-win"
  | "robbing-kong"
  | "seat-wind"
  | "self-pick"
  | "seven-pairs"
  | "small-dragons"
  | "small-winds"
  | "terminals-only"
  | "thirteen-orphans"
  | "white-dragon";

export interface DetectedPattern {
  readonly category: PatternCategory;
  readonly faan: number;
  readonly id: PatternId;
}

export const patternCatalog = {
  "all-honors": { category: "limit", faan: 10 },
  "all-one-suit": { category: "hand", faan: 7 },
  "all-seasons": { category: "bonus", faan: 2 },
  "all-flowers": { category: "bonus", faan: 2 },
  "all-triplets": { category: "hand", faan: 3 },
  "common-hand": { category: "hand", faan: 1 },
  "double-kong-win": { category: "winning-condition", faan: 8 },
  "earthly-hand": { category: "winning-condition", faan: 13 },
  "four-concealed-triplets": { category: "limit", faan: 10 },
  "four-kongs": { category: "limit", faan: 13 },
  "fully-concealed": { category: "winning-condition", faan: 1 },
  "great-dragons": { category: "hand", faan: 8 },
  "great-winds": { category: "limit", faan: 13 },
  "green-dragon": { category: "value-honor", faan: 1 },
  "heavenly-hand": { category: "winning-condition", faan: 13 },
  "last-catch": { category: "winning-condition", faan: 1 },
  "matching-flower": { category: "bonus", faan: 1 },
  "matching-season": { category: "bonus", faan: 1 },
  "mixed-one-suit": { category: "hand", faan: 3 },
  "mixed-orphans": { category: "hand", faan: 1 },
  "nine-gates": { category: "limit", faan: 10 },
  "no-bonuses": { category: "bonus", faan: 1 },
  "prevailing-wind": { category: "value-honor", faan: 1 },
  "red-dragon": { category: "value-honor", faan: 1 },
  "replacement-win": { category: "winning-condition", faan: 1 },
  "robbing-kong": { category: "winning-condition", faan: 1 },
  "seat-wind": { category: "value-honor", faan: 1 },
  "self-pick": { category: "winning-condition", faan: 1 },
  "seven-pairs": { category: "hand", faan: 4 },
  "small-dragons": { category: "hand", faan: 5 },
  "small-winds": { category: "hand", faan: 6 },
  "terminals-only": { category: "limit", faan: 10 },
  "thirteen-orphans": { category: "limit", faan: 13 },
  "white-dragon": { category: "value-honor", faan: 1 },
} as const satisfies Record<
  PatternId,
  { readonly category: PatternCategory; readonly faan: number }
>;

function pattern(id: PatternId): DetectedPattern {
  return { id, ...patternCatalog[id] };
}

function structuralTileIds(fixture: ScoringHandFixture): readonly TileId[] {
  return [
    ...fixture.concealedTileIds,
    ...fixture.declaredMelds.flatMap((meld) => meld.tileIds),
  ];
}

function standardKinds(ids: readonly TileId[]): readonly StandardTileKind[] {
  return ids.map((id) => {
    const kind = tileKind(id);
    if (kind.type === "bonus")
      throw new Error("Structural bonus escaped validation.");
    return kind;
  });
}

function isTerminalOrHonor(kind: StandardTileKind): boolean {
  return kind.type !== "suited" || kind.rank === 1 || kind.rank === 9;
}

function meldKind(meld: ScoringMeld): StandardTileKind {
  const first = meld.tileIds[0];
  if (first === undefined) throw new Error("A scoring meld cannot be empty.");
  const kind = tileKind(first);
  if (kind.type === "bonus") throw new Error("Meld bonus escaped validation.");
  return kind;
}

function hasMeld(
  decomposition: HandDecomposition,
  predicate: (kind: StandardTileKind, meld: ScoringMeld) => boolean,
): boolean {
  return (
    decomposition.kind === "standard" &&
    decomposition.melds.some((meld) => predicate(meldKind(meld), meld))
  );
}

function pairKind(decomposition: HandDecomposition): StandardTileKind | null {
  if (decomposition.kind !== "standard") return null;
  const kind = tileKind(decomposition.pair[0]);
  if (kind.type === "bonus") throw new Error("Pair bonus escaped validation.");
  return kind;
}

function countMelds(
  decomposition: HandDecomposition,
  predicate: (kind: StandardTileKind, meld: ScoringMeld) => boolean,
): number {
  if (decomposition.kind !== "standard") return 0;
  return decomposition.melds.filter((meld) => predicate(meldKind(meld), meld))
    .length;
}

function detectOrdinaryAndLimit(
  fixture: ScoringHandFixture,
  decomposition: HandDecomposition,
  detected: DetectedPattern[],
): void {
  const kinds = standardKinds(structuralTileIds(fixture));
  const suits = new Set(
    kinds.flatMap((kind) => (kind.type === "suited" ? [kind.suit] : [])),
  );
  const hasHonors = kinds.some((kind) => kind.type !== "suited");

  const candidatePair = pairKind(decomposition);
  if (
    decomposition.kind === "standard" &&
    decomposition.melds.every((meld) => meld.kind === "chow")
  ) {
    detected.push(pattern("common-hand"));
  }
  if (
    decomposition.kind === "standard" &&
    decomposition.melds.every((meld) => meld.kind !== "chow")
  ) {
    detected.push(pattern("all-triplets"));
  }
  if (suits.size === 1 && hasHonors) detected.push(pattern("mixed-one-suit"));
  if (suits.size === 1 && !hasHonors) detected.push(pattern("all-one-suit"));
  if (
    decomposition.kind === "standard" &&
    decomposition.melds.every(
      (meld) => meld.kind !== "chow" && isTerminalOrHonor(meldKind(meld)),
    ) &&
    candidatePair !== null &&
    isTerminalOrHonor(candidatePair)
  ) {
    detected.push(pattern("mixed-orphans"));
  }

  const dragonMelds = countMelds(
    decomposition,
    (kind) => kind.type === "dragon",
  );
  const pair = pairKind(decomposition);
  if (dragonMelds === 2 && pair?.type === "dragon") {
    detected.push(pattern("small-dragons"));
  }
  if (dragonMelds === 3) detected.push(pattern("great-dragons"));
  const windMelds = countMelds(decomposition, (kind) => kind.type === "wind");
  if (windMelds === 3 && pair?.type === "wind") {
    detected.push(pattern("small-winds"));
  }
  if (decomposition.kind === "seven-pairs") {
    detected.push(pattern("seven-pairs"));
  }

  if (kinds.every((kind) => kind.type !== "suited")) {
    detected.push(pattern("all-honors"));
  }
  if (
    decomposition.kind === "standard" &&
    decomposition.melds.every((meld) => meld.kind !== "chow") &&
    kinds.every(
      (kind) => kind.type === "suited" && (kind.rank === 1 || kind.rank === 9),
    )
  ) {
    detected.push(pattern("terminals-only"));
  }
  if (isFourConcealedTriplets(fixture, decomposition)) {
    detected.push(pattern("four-concealed-triplets"));
  }
  if (isNineGates(fixture)) detected.push(pattern("nine-gates"));
  if (windMelds === 4) detected.push(pattern("great-winds"));
  if (
    decomposition.kind === "standard" &&
    decomposition.melds.length === 4 &&
    decomposition.melds.every(
      (meld) => meld.kind === "kong" && meld.origin === "declared",
    )
  ) {
    detected.push(pattern("four-kongs"));
  }
  if (decomposition.kind === "thirteen-orphans") {
    detected.push(pattern("thirteen-orphans"));
  }
}

function isFourConcealedTriplets(
  fixture: ScoringHandFixture,
  decomposition: HandDecomposition,
): boolean {
  if (
    decomposition.kind !== "standard" ||
    decomposition.melds.some(
      (meld) => meld.kind === "chow" || meld.exposure === "exposed",
    )
  ) {
    return false;
  }
  if (fixture.winningTileSource.type === "self-pick") return true;
  return decomposition.pair.includes(fixture.winningTileId);
}

function isNineGates(fixture: ScoringHandFixture): boolean {
  if (fixture.declaredMelds.length !== 0) return false;
  const kinds = standardKinds(fixture.concealedTileIds);
  if (kinds.some((kind) => kind.type !== "suited")) return false;
  const suitedKinds = kinds.filter((kind) => kind.type === "suited");
  const suit = suitedKinds[0]?.suit;
  if (suit === undefined || suitedKinds.some((kind) => kind.suit !== suit)) {
    return false;
  }
  const counts = new Map<number, number>();
  for (const kind of suitedKinds) {
    counts.set(kind.rank, (counts.get(kind.rank) ?? 0) + 1);
  }
  return (
    (counts.get(1) ?? 0) >= 3 &&
    (counts.get(9) ?? 0) >= 3 &&
    [2, 3, 4, 5, 6, 7, 8].every((rank) => (counts.get(rank) ?? 0) >= 1)
  );
}

function detectValueHonors(
  fixture: ScoringHandFixture,
  decomposition: HandDecomposition,
  detected: DetectedPattern[],
): void {
  if (
    hasMeld(
      decomposition,
      (kind) => kind.type === "wind" && kind.wind === fixture.winnerSeat,
    )
  ) {
    detected.push(pattern("seat-wind"));
  }
  if (
    hasMeld(
      decomposition,
      (kind) => kind.type === "wind" && kind.wind === fixture.prevailingWind,
    )
  ) {
    detected.push(pattern("prevailing-wind"));
  }
  for (const dragon of ["green", "red", "white"] as const) {
    if (
      hasMeld(
        decomposition,
        (kind) => kind.type === "dragon" && kind.dragon === dragon,
      )
    ) {
      detected.push(pattern(`${dragon}-dragon`));
    }
  }
}

function detectBonuses(
  fixture: ScoringHandFixture,
  detected: DetectedPattern[],
): void {
  const bonuses = fixture.bonusTileIds.map((id) => tileKind(id));
  if (bonuses.length === 0) {
    detected.push(pattern("no-bonuses"));
    return;
  }
  const seasons = bonuses.filter(
    (kind) => kind.type === "bonus" && kind.family === "season",
  );
  const flowers = bonuses.filter(
    (kind) => kind.type === "bonus" && kind.family === "flower",
  );
  if (seasons.length === 4) detected.push(pattern("all-seasons"));
  if (flowers.length === 4) detected.push(pattern("all-flowers"));
  if (seasons.some((kind) => kind.matchingSeat === fixture.winnerSeat)) {
    detected.push(pattern("matching-season"));
  }
  if (flowers.some((kind) => kind.matchingSeat === fixture.winnerSeat)) {
    detected.push(pattern("matching-flower"));
  }
}

function detectWinningConditions(
  fixture: ScoringHandFixture,
  detected: DetectedPattern[],
): void {
  if (fixture.winningTileSource.type === "self-pick") {
    detected.push(pattern("self-pick"));
  }
  if (fixture.declaredMelds.every((meld) => meld.exposure === "concealed")) {
    detected.push(pattern("fully-concealed"));
  }
  if (fixture.winningTileSource.type === "robbing-kong") {
    detected.push(pattern("robbing-kong"));
  }
  if (fixture.winningConditions.wallPosition !== "ordinary") {
    detected.push(pattern("last-catch"));
  }
  if (fixture.winningConditions.replacement !== "none") {
    detected.push(pattern("replacement-win"));
  }
  if (fixture.winningConditions.replacement === "double-kong") {
    detected.push(pattern("double-kong-win"));
  }
  if (fixture.winningConditions.opening === "heavenly") {
    detected.push(pattern("heavenly-hand"));
  }
  if (fixture.winningConditions.opening === "earthly") {
    detected.push(pattern("earthly-hand"));
  }
}

export function detectPatterns(
  fixture: ScoringHandFixture,
  decomposition: HandDecomposition,
): readonly DetectedPattern[] {
  const detected: DetectedPattern[] = [];
  detectOrdinaryAndLimit(fixture, decomposition, detected);
  detectValueHonors(fixture, decomposition, detected);
  detectBonuses(fixture, detected);
  detectWinningConditions(fixture, detected);
  return detected.sort((left, right) => left.id.localeCompare(right.id));
}
