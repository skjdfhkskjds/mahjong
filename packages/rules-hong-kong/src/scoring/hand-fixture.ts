import {
  nextSeat,
  tileId,
  type Seat,
  type StandardTileKind,
  type TileId,
} from "@mahjong/game-core";

import type { DeclaredMeld } from "../melds/meld.js";
import { tileKind, tileKindKey } from "../tiles/tile-kind-identity.js";
import { createHongKongV1TileSet } from "../wall/create-tile-set.js";

export type WinningTileSource =
  | { readonly type: "self-pick" }
  | { readonly type: "discard"; readonly sourceSeat: Seat }
  | { readonly type: "robbing-kong"; readonly sourceSeat: Seat };

export interface WinningConditions {
  readonly opening: "earthly" | "heavenly" | "none";
  readonly replacement: "bonus" | "double-kong" | "kong" | "none";
  readonly wallPosition:
    "discard-after-final-wall-tile" | "final-wall-tile" | "ordinary";
}

export interface ScoringHandFixture {
  readonly bonusTileIds: readonly TileId[];
  readonly concealedTileIds: readonly TileId[];
  readonly declaredMelds: readonly DeclaredMeld[];
  readonly prevailingWind: Seat;
  readonly winnerSeat: Seat;
  readonly winningConditions: WinningConditions;
  readonly winningTileId: TileId;
  readonly winningTileSource: WinningTileSource;
}

export interface ScoringHandFixtureInput {
  readonly bonusTileIds?: readonly TileId[];
  readonly concealedTileIds: readonly TileId[];
  readonly declaredMelds?: readonly DeclaredMeld[];
  readonly prevailingWind: Seat;
  readonly winnerSeat: Seat;
  readonly winningConditions?: Partial<WinningConditions>;
  readonly winningTileId: TileId;
  readonly winningTileSource: WinningTileSource;
}

function compareTileIds(left: TileId, right: TileId): number {
  return Number(left) - Number(right);
}

function assertMeld(meld: DeclaredMeld): void {
  if (meld.id.trim().length === 0) {
    throw new RangeError("A declared meld ID cannot be empty.");
  }
  const expectedLength = meld.kind === "kong" ? 4 : 3;
  if (meld.tileIds.length !== expectedLength) {
    throw new RangeError(
      `A declared ${meld.kind} must contain ${String(expectedLength)} tiles.`,
    );
  }
  const keys = meld.tileIds.map(tileKindKey);
  if (meld.kind === "chow") {
    const kinds = meld.tileIds.map(tileKind);
    const first = kinds[0];
    if (
      first?.type !== "suited" ||
      kinds.some((kind) => kind.type !== "suited" || kind.suit !== first.suit)
    ) {
      throw new RangeError("A declared chow must contain one suited sequence.");
    }
    const ranks = kinds
      .map((kind) => (kind.type === "suited" ? kind.rank : 0))
      .sort((left, right) => left - right);
    const [firstRank, secondRank, thirdRank] = ranks;
    if (
      firstRank === undefined ||
      secondRank !== firstRank + 1 ||
      thirdRank !== firstRank + 2
    ) {
      throw new RangeError("A declared chow must contain consecutive ranks.");
    }
  } else if (keys.some((key) => key !== keys[0])) {
    throw new RangeError(`A declared ${meld.kind} must contain one tile kind.`);
  }

  if (meld.kind === "kong") {
    if (meld.kongKind === undefined) {
      throw new RangeError("A declared kong must identify its kong kind.");
    }
    if ((meld.kongKind === "concealed") !== (meld.exposure === "concealed")) {
      throw new RangeError("Kong kind and exposure disagree.");
    }
  } else if (meld.kongKind !== undefined) {
    throw new RangeError("Only a kong may identify a kong kind.");
  }

  if (meld.kind !== "kong" && meld.exposure !== "exposed") {
    throw new RangeError(
      "Only a declared concealed kong may remain concealed.",
    );
  }
  if (
    meld.exposure === "concealed" &&
    (meld.claimedTileId !== undefined || meld.sourceSeat !== undefined)
  ) {
    throw new RangeError("A concealed kong cannot carry claim provenance.");
  }
  if (
    meld.exposure === "exposed" &&
    (meld.claimedTileId === undefined || meld.sourceSeat === undefined)
  ) {
    throw new RangeError(
      "Every exposed meld must carry claimed-tile and source-seat provenance.",
    );
  }
}

function assertOpeningCondition(
  fixture: Pick<
    ScoringHandFixture,
    "winnerSeat" | "winningConditions" | "winningTileSource"
  >,
): void {
  if (
    fixture.winningConditions.opening === "heavenly" &&
    (fixture.winnerSeat !== "east" ||
      fixture.winningTileSource.type !== "self-pick")
  ) {
    throw new RangeError(
      "Heavenly Hand requires East to win before discarding.",
    );
  }
  if (
    fixture.winningConditions.opening === "earthly" &&
    (fixture.winnerSeat === "east" ||
      fixture.winningTileSource.type !== "discard" ||
      fixture.winningTileSource.sourceSeat !== "east")
  ) {
    throw new RangeError(
      "Earthly Hand requires a non-East seat to win on East's discard.",
    );
  }
}

export function createScoringHandFixture(
  input: ScoringHandFixtureInput,
): ScoringHandFixture {
  const declaredMelds = [...(input.declaredMelds ?? [])].map((meld) => ({
    ...meld,
    tileIds: [...meld.tileIds].sort(compareTileIds),
  }));
  for (const meld of declaredMelds) assertMeld(meld);
  if (
    new Set(declaredMelds.map((meld) => meld.id)).size !== declaredMelds.length
  ) {
    throw new RangeError("Declared meld IDs must be unique.");
  }
  if (
    declaredMelds.some(
      (meld) =>
        meld.claimedTileId !== undefined &&
        !meld.tileIds.includes(meld.claimedTileId),
    )
  ) {
    throw new RangeError("A claimed tile must belong to its declared meld.");
  }

  const fixture: ScoringHandFixture = {
    bonusTileIds: [...(input.bonusTileIds ?? [])].sort(compareTileIds),
    concealedTileIds: [...input.concealedTileIds].sort(compareTileIds),
    declaredMelds,
    prevailingWind: input.prevailingWind,
    winnerSeat: input.winnerSeat,
    winningConditions: {
      opening: input.winningConditions?.opening ?? "none",
      replacement: input.winningConditions?.replacement ?? "none",
      wallPosition: input.winningConditions?.wallPosition ?? "ordinary",
    },
    winningTileId: input.winningTileId,
    winningTileSource: input.winningTileSource,
  };
  if (
    fixture.declaredMelds.some((meld) => {
      if (meld.exposure !== "exposed" || meld.sourceSeat === undefined) {
        return false;
      }
      return meld.kind === "chow"
        ? nextSeat(meld.sourceSeat) !== fixture.winnerSeat
        : meld.sourceSeat === fixture.winnerSeat;
    })
  ) {
    throw new RangeError(
      "Exposed meld source provenance is impossible for its owner.",
    );
  }

  const structuralSize =
    fixture.concealedTileIds.length + fixture.declaredMelds.length * 3;
  if (structuralSize !== 14) {
    throw new RangeError(
      "A scoring fixture must contain fourteen structural tile slots.",
    );
  }
  if (!fixture.concealedTileIds.includes(fixture.winningTileId)) {
    throw new RangeError(
      "The winning tile must be in the completed concealed hand.",
    );
  }

  const allIds = [
    ...fixture.concealedTileIds,
    ...fixture.bonusTileIds,
    ...fixture.declaredMelds.flatMap((meld) => meld.tileIds),
  ];
  if (new Set(allIds).size !== allIds.length) {
    throw new RangeError(
      "A physical tile may appear only once in a scoring fixture.",
    );
  }
  if (fixture.concealedTileIds.some((id) => tileKind(id).type === "bonus")) {
    throw new RangeError("Bonus tiles cannot be structural concealed tiles.");
  }
  if (
    fixture.declaredMelds.some((meld) =>
      meld.tileIds.some((id) => tileKind(id).type === "bonus"),
    )
  ) {
    throw new RangeError("Bonus tiles cannot be declared meld tiles.");
  }
  if (fixture.bonusTileIds.some((id) => tileKind(id).type !== "bonus")) {
    throw new RangeError("The bonus list may contain only bonus tiles.");
  }
  if (
    fixture.winningConditions.replacement !== "none" &&
    fixture.winningTileSource.type !== "self-pick"
  ) {
    throw new RangeError("A replacement win must be self-picked.");
  }
  if (
    fixture.winningTileSource.type !== "self-pick" &&
    fixture.winningTileSource.sourceSeat === fixture.winnerSeat
  ) {
    throw new RangeError("The winning source seat cannot also be the winner.");
  }
  if (
    fixture.winningConditions.wallPosition === "final-wall-tile" &&
    fixture.winningTileSource.type !== "self-pick"
  ) {
    throw new RangeError("The final wall tile itself must be self-picked.");
  }
  if (
    fixture.winningConditions.wallPosition ===
      "discard-after-final-wall-tile" &&
    fixture.winningTileSource.type !== "discard"
  ) {
    throw new RangeError(
      "Last Catch after the final wall tile requires the following discard.",
    );
  }
  const kongCount = fixture.declaredMelds.filter(
    (meld) => meld.kind === "kong",
  ).length;
  if (fixture.winningConditions.replacement === "kong" && kongCount < 1) {
    throw new RangeError("A kong replacement win requires a declared kong.");
  }
  if (
    fixture.winningConditions.replacement === "double-kong" &&
    kongCount < 2
  ) {
    throw new RangeError("A Double Kong Win requires two declared kongs.");
  }
  if (
    fixture.winningConditions.replacement === "bonus" &&
    fixture.bonusTileIds.length === 0
  ) {
    throw new RangeError("A bonus replacement win requires an exposed bonus.");
  }
  if (
    fixture.winningConditions.opening === "heavenly" &&
    (fixture.winningConditions.replacement === "kong" ||
      fixture.winningConditions.replacement === "double-kong")
  ) {
    throw new RangeError("A kong disqualifies Heavenly Hand.");
  }
  if (
    fixture.winningConditions.opening === "heavenly" &&
    fixture.declaredMelds.length !== 0
  ) {
    throw new RangeError("A declared meld disqualifies Heavenly Hand.");
  }
  if (
    fixture.winningConditions.opening === "heavenly" &&
    fixture.winningConditions.wallPosition !== "ordinary"
  ) {
    throw new RangeError("Heavenly Hand cannot also be Last Catch.");
  }
  if (
    fixture.winningConditions.opening === "earthly" &&
    (fixture.declaredMelds.length !== 0 ||
      fixture.winningConditions.replacement !== "none" ||
      fixture.winningConditions.wallPosition !== "ordinary")
  ) {
    throw new RangeError(
      "Earthly Hand cannot follow a meld, replacement, or final-wall action.",
    );
  }
  assertOpeningCondition(fixture);
  return fixture;
}

const tileInventory = createHongKongV1TileSet();

export function scoringTileId(
  kind: StandardTileKind,
  copyIndex: 0 | 1 | 2 | 3,
): TileId {
  const matchingIds = tileInventory
    .filter((tile) => tile.kind.type !== "bonus")
    .filter((tile) => {
      if (kind.type === "suited") {
        return (
          tile.kind.type === "suited" &&
          tile.kind.suit === kind.suit &&
          tile.kind.rank === kind.rank
        );
      }
      if (kind.type === "wind") {
        return tile.kind.type === "wind" && tile.kind.wind === kind.wind;
      }
      return tile.kind.type === "dragon" && tile.kind.dragon === kind.dragon;
    })
    .map((tile) => tile.id);
  const id = matchingIds[copyIndex];
  if (id === undefined) throw new RangeError("Unknown structural tile kind.");
  return tileId(Number(id));
}
