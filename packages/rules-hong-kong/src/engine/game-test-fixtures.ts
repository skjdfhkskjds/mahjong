import { seats, type Seat, type TileId } from "@mahjong/game-core";

import type { DeclaredMeld } from "../melds/meld.js";
import {
  createScoringHandFixture,
  type ScoringHandFixture,
} from "../scoring/hand-fixture.js";
import { createHongKongV1TileSet } from "../wall/create-tile-set.js";
import { HONG_KONG_V1_SHUFFLE_ALGORITHM } from "../wall/deterministic-shuffle.js";
import {
  applyGameCommandV1,
  assertGameInvariants,
  type CanonicalGameStateV1,
  type SeatMap,
} from "./hong-kong-game.js";

export const actors: SeatMap<string> = {
  east: "actor:east",
  south: "actor:south",
  west: "actor:west",
  north: "actor:north",
};

interface PlayerPlacement {
  readonly bonuses?: readonly TileId[];
  readonly discards?: readonly TileId[];
  readonly hand?: readonly TileId[];
  readonly melds?: readonly DeclaredMeld[];
}

type SeatName = keyof SeatMap<unknown>;
type MutablePlayers = {
  -readonly [
    Key in keyof CanonicalGameStateV1["players"]
  ]: CanonicalGameStateV1["players"][Key];
};

export function seatName(currentSeat: Seat): SeatName {
  return String(currentSeat) as SeatName;
}

export function buildPreDiscardState(input: {
  readonly eastHasDeclaredKong?: boolean;
  readonly eastHasDiscarded?: boolean;
  readonly lastAcquiredTileId: TileId | null;
  readonly lastAcquiredTileWasFinalWall?: boolean;
  readonly lastAcquisition?: CanonicalGameStateV1["turnProvenance"]["lastAcquisition"];
  readonly placements: Partial<SeatMap<PlayerPlacement>>;
  readonly phase?:
    "awaiting-dealer-discard" | "awaiting-discard" | "awaiting-draw";
  readonly replacementChainDepth?: number;
  readonly wallFinalTileId?: TileId;
  readonly liveWallTileIds?: readonly TileId[];
  readonly turn: Seat;
}): CanonicalGameStateV1 {
  const phase = input.phase ?? "awaiting-discard";
  const liveWallTileIds =
    input.liveWallTileIds ??
    (input.wallFinalTileId === undefined ? undefined : [input.wallFinalTileId]);
  const reserved = new Set(liveWallTileIds);
  const used = new Set<TileId>();
  const mutable = Object.fromEntries(
    seats.map((currentSeat) => {
      const placement = input.placements[seatName(currentSeat)] ?? {};
      const player = {
        actorId: actors[seatName(currentSeat)],
        bonuses: [...(placement.bonuses ?? [])],
        discards: [...(placement.discards ?? [])],
        hand: [...(placement.hand ?? [])],
        melds: [...(placement.melds ?? [])],
        seat: currentSeat,
      };
      for (const id of [
        ...player.bonuses,
        ...player.discards,
        ...player.hand,
        ...player.melds.flatMap((meld) => meld.tileIds),
      ]) {
        if (used.has(id)) throw new Error("Fixture repeats a physical tile.");
        used.add(id);
      }
      return [currentSeat, player] as const;
    }),
  ) as unknown as MutablePlayers;
  const availableStructural = createHongKongV1TileSet()
    .filter(
      (tile) =>
        tile.kind.type !== "bonus" &&
        !used.has(tile.id) &&
        !reserved.has(tile.id),
    )
    .map((tile) => tile.id);
  for (const currentSeat of seats) {
    const player = mutable[seatName(currentSeat)];
    const structuralTarget =
      currentSeat === input.turn && phase !== "awaiting-draw" ? 14 : 13;
    const requiredHandSize = structuralTarget - player.melds.length * 3;
    const hand = [...player.hand];
    while (hand.length < requiredHandSize) {
      const id = availableStructural.shift();
      if (id === undefined) throw new Error("Fixture ran out of live tiles.");
      hand.push(id);
      used.add(id);
    }
    if (hand.length !== requiredHandSize) {
      throw new Error("Fixture hand exceeds its structural target.");
    }
    mutable[seatName(currentSeat)] = { ...player, hand };
  }
  if (liveWallTileIds !== undefined) {
    if (liveWallTileIds.some((id) => used.has(id))) {
      throw new Error("Final wall tile is already owned.");
    }
    const bonuses = [...mutable.east.bonuses];
    const discards = [...mutable.east.discards];
    for (const tile of createHongKongV1TileSet()) {
      if (used.has(tile.id) || reserved.has(tile.id)) continue;
      if (tile.kind.type === "bonus") bonuses.push(tile.id);
      else discards.push(tile.id);
      used.add(tile.id);
    }
    mutable.east = { ...mutable.east, bonuses, discards };
  }
  const owned = seats.flatMap((currentSeat) => {
    const player = mutable[seatName(currentSeat)];
    return [
      ...player.hand,
      ...player.bonuses,
      ...player.discards,
      ...player.melds.flatMap((meld) => meld.tileIds),
    ];
  });
  const remaining =
    liveWallTileIds ??
    createHongKongV1TileSet()
      .map((tile) => tile.id)
      .filter((id) => !used.has(id));
  const acquisition =
    input.lastAcquisition ??
    (input.lastAcquiredTileId === null ? null : "draw");
  let head = owned.length;
  let tail = owned.length + remaining.length - 1;
  let order = [...owned, ...remaining];
  if (input.lastAcquiredTileId !== null && acquisition === "draw") {
    const acquiredIndex = order.indexOf(input.lastAcquiredTileId);
    const historyIndex = owned.length - 1;
    const displaced = order[historyIndex];
    if (acquiredIndex < 0 || displaced === undefined) {
      throw new Error("Draw provenance fixture is incomplete.");
    }
    order[historyIndex] = input.lastAcquiredTileId;
    order[acquiredIndex] = displaced;
  } else if (
    input.lastAcquiredTileId !== null &&
    (acquisition === "bonus-replacement" || acquisition === "kong-replacement")
  ) {
    const historicalOwned = owned.filter(
      (id) => id !== input.lastAcquiredTileId,
    );
    if (historicalOwned.length !== owned.length - 1) {
      throw new Error("Replacement provenance fixture is incomplete.");
    }
    if (acquisition === "bonus-replacement") {
      const bonusIndex = historicalOwned.findIndex((id) => Number(id) >= 136);
      const bonusId = historicalOwned[bonusIndex];
      const finalHistorical = historicalOwned.at(-1);
      if (
        bonusIndex < 0 ||
        bonusId === undefined ||
        finalHistorical === undefined
      ) {
        throw new Error("Bonus replacement fixture lacks its exposed bonus.");
      }
      historicalOwned[bonusIndex] = finalHistorical;
      historicalOwned[historicalOwned.length - 1] = bonusId;
    }
    order = [...historicalOwned, ...remaining, input.lastAcquiredTileId];
    head = historicalOwned.length;
    tail = order.length - 2;
  }
  const state: CanonicalGameStateV1 = {
    completionProvenance: null,
    phase,
    players: mutable,
    prevailingWind: "east",
    reactionWindow: null,
    result: null,
    ruleset: "hong-kong/v1",
    schemaVersion: 1,
    sequence: 1,
    shuffleAlgorithm: HONG_KONG_V1_SHUFFLE_ALGORITHM,
    turn: input.turn,
    turnProvenance: {
      eastHasDeclaredKong:
        input.eastHasDeclaredKong ??
        mutable.east.melds.some((meld) => meld.kind === "kong"),
      eastHasDiscarded: input.eastHasDiscarded ?? true,
      lastAcquiredTileId: input.lastAcquiredTileId,
      lastAcquiredTileWasFinalWall: input.lastAcquiredTileWasFinalWall ?? false,
      lastAcquisition: acquisition,
      replacementChainDepth: input.replacementChainDepth ?? 0,
      replacementPending: false,
    },
    wall: {
      head,
      order,
      tail,
    },
  };
  assertGameInvariants(state);
  return state;
}

export function withoutWinningTile(
  fixture: ScoringHandFixture,
): readonly TileId[] {
  let removed = false;
  return fixture.concealedTileIds.filter((id) => {
    if (!removed && id === fixture.winningTileId) {
      removed = true;
      return false;
    }
    return true;
  });
}

export function withWinningCopy(
  fixture: ScoringHandFixture,
  existingCopy: TileId,
  sourceTileId: TileId,
): ScoringHandFixture {
  const matching = fixture.concealedTileIds.filter(
    (id) =>
      id === fixture.winningTileId ||
      Number(id) === Number(fixture.winningTileId) - 1,
  );
  if (matching.length !== 2) throw new Error("Fixture pair is absent.");
  return createScoringHandFixture({
    ...fixture,
    concealedTileIds: fixture.concealedTileIds.map((id) =>
      id === matching[0]
        ? existingCopy
        : id === matching[1]
          ? sourceTileId
          : id,
    ),
    winningTileId: sourceTileId,
  });
}

export function openDiscard(
  fixtureHands: Partial<SeatMap<readonly TileId[]>>,
  sourceSeat: Seat,
  sourceTileId: TileId,
): CanonicalGameStateV1 {
  const initial = buildPreDiscardState({
    lastAcquiredTileId: sourceTileId,
    placements: Object.fromEntries(
      seats.flatMap((currentSeat) => {
        const hand = fixtureHands[seatName(currentSeat)];
        return hand === undefined ? [] : [[currentSeat, { hand }] as const];
      }),
    ),
    turn: sourceSeat,
  });
  const opened = applyGameCommandV1(initial, actors[seatName(sourceSeat)], {
    type: "game/discard",
    tileId: sourceTileId,
  });
  if (!opened.accepted || opened.state === undefined) {
    throw new Error("Fixture discard failed.");
  }
  return opened.state;
}
