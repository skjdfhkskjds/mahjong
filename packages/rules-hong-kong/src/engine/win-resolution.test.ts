import {
  seat,
  seats,
  tileId,
  type Seat,
  type TileId,
} from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import type { DeclaredMeld } from "../melds/meld.js";
import { initialDealSeatOrder } from "../setup/initial-deal.js";
import {
  createScoringHandFixture,
  type ScoringHandFixture,
} from "../scoring/hand-fixture.js";
import { scoreHongKongHand } from "../scoring/score-hand.js";
import { scoringFixture } from "../scoring/scoring-test-fixtures.js";
import { createHongKongV1TileSet } from "../wall/create-tile-set.js";
import { HONG_KONG_V1_SHUFFLE_ALGORITHM } from "../wall/deterministic-shuffle.js";
import {
  applyGameCommandV2,
  assertGameInvariants,
  assertVersionedCheckpointMatchesReplay,
  canonicalVersionedGameEventJson,
  canonicalVersionedGameJson,
  createStateUpgradeEvent,
  decodeCanonicalVersionedGameEventJson,
  decodeCanonicalVersionedGameJson,
  decideReactionExpiration,
  projectGameV2,
  reduceVersionedGameEvent,
  replayVersionedGameEvents,
  startHongKongV1Game,
  startHongKongV2Game,
  type CanonicalGameStateV1,
  type CanonicalGameStateV2,
  type CompletedHandResult,
  type SeatMap,
  type VersionedHongKongGameEvent,
} from "./hong-kong-game.js";
import { canonicalJson } from "./game-codec.js";

const actors: SeatMap<string> = {
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
    Key in keyof CanonicalGameStateV2["players"]
  ]: CanonicalGameStateV2["players"][Key];
};

function seatName(currentSeat: Seat): SeatName {
  return String(currentSeat) as SeatName;
}

function buildPreDiscardState(input: {
  readonly eastHasDeclaredKong?: boolean;
  readonly eastHasDiscarded?: boolean;
  readonly lastAcquiredTileId: TileId | null;
  readonly lastAcquiredTileWasFinalWall?: boolean;
  readonly lastAcquisition?: CanonicalGameStateV2["turnProvenance"]["lastAcquisition"];
  readonly placements: Partial<SeatMap<PlayerPlacement>>;
  readonly phase?:
    "awaiting-dealer-discard" | "awaiting-discard" | "awaiting-draw";
  readonly replacementChainDepth?: number;
  readonly wallFinalTileId?: TileId;
  readonly turn: Seat;
}): CanonicalGameStateV2 {
  const phase = input.phase ?? "awaiting-discard";
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
        tile.id !== input.wallFinalTileId,
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
  if (input.wallFinalTileId !== undefined) {
    if (used.has(input.wallFinalTileId)) {
      throw new Error("Final wall tile is already owned.");
    }
    const bonuses = [...mutable.east.bonuses];
    const discards = [...mutable.east.discards];
    for (const tile of createHongKongV1TileSet()) {
      if (used.has(tile.id) || tile.id === input.wallFinalTileId) continue;
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
  const remaining = createHongKongV1TileSet()
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
  const state: CanonicalGameStateV2 = {
    completionProvenance: null,
    phase,
    players: mutable,
    prevailingWind: "east",
    reactionWindow: null,
    result: null,
    ruleset: "hong-kong/v1",
    schemaVersion: 2,
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

function withoutWinningTile(fixture: ScoringHandFixture): readonly TileId[] {
  let removed = false;
  return fixture.concealedTileIds.filter((id) => {
    if (!removed && id === fixture.winningTileId) {
      removed = true;
      return false;
    }
    return true;
  });
}

function withWinningCopy(
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

function openDiscard(
  fixtureHands: Partial<SeatMap<readonly TileId[]>>,
  sourceSeat: Seat,
  sourceTileId: TileId,
): CanonicalGameStateV2 {
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
  const opened = applyGameCommandV2(initial, actors[seatName(sourceSeat)], {
    type: "game/discard",
    tileId: sourceTileId,
  });
  if (!opened.accepted || opened.state === undefined) {
    throw new Error("Fixture discard failed.");
  }
  return opened.state;
}

function submit(
  state: CanonicalGameStateV2,
  responder: Seat,
  response: { readonly type: "pass" | "win" },
): ReturnType<typeof applyGameCommandV2> {
  if (state.reactionWindow === null) throw new Error("No reaction window.");
  return applyGameCommandV2(state, actors[seatName(responder)], {
    type: "game/react",
    response,
    windowId: state.reactionWindow.id,
  });
}

function putWallTileAtTail(
  state: CanonicalGameStateV2,
  id: TileId,
): CanonicalGameStateV2 {
  const index = state.wall.order.indexOf(id);
  if (index < state.wall.head || index > state.wall.tail) {
    throw new Error("Tail fixture tile is not in the live wall.");
  }
  const order = [...state.wall.order];
  const tailTile = order[state.wall.tail];
  if (tailTile === undefined) throw new Error("Tail fixture is empty.");
  order[index] = tailTile;
  order[state.wall.tail] = id;
  const next = { ...state, wall: { ...state.wall, order } };
  assertGameInvariants(next);
  return next;
}

function expireReactions(state: CanonicalGameStateV2): CanonicalGameStateV2 {
  const decision = decideReactionExpiration(state);
  if (!decision.accepted) throw new Error("Reaction expiration failed.");
  let next = state;
  for (const event of decision.events) {
    next = reduceVersionedGameEvent(next, event) as CanonicalGameStateV2;
  }
  return next;
}

function randomness(offset: number): Uint8Array {
  return Uint8Array.from(
    { length: 1_028 },
    (_, index) => (index * 73 + offset) & 0xff,
  );
}

function completedResultForFixture(
  fixture: ScoringHandFixture,
): CompletedHandResult {
  const score = scoreHongKongHand(fixture);
  if (score === null) throw new Error("Fixture must be a legal scored win.");
  return {
    awardedPatterns: score.awardedPatterns,
    bonusFaan: score.bonusFaan,
    cappedFaan: score.cappedFaan,
    decomposition: score.decomposition,
    detectedPatterns: score.detectedPatterns,
    eligibilityFaan: score.eligibilityFaan,
    explanation: score.explanation,
    isLegalWin: true,
    payments: score.payments,
    rawFaan: score.rawFaan,
    source: fixture.winningTileSource,
    suppressedPatterns: score.suppressedPatterns,
    tablePoints: score.tablePoints,
    winnerSeat: fixture.winnerSeat,
    winningConditions: fixture.winningConditions,
    winningHand: {
      bonusTileIds: fixture.bonusTileIds,
      concealedTileIds: fixture.concealedTileIds,
      declaredMelds: fixture.declaredMelds,
    },
    winningTileId: fixture.winningTileId,
  };
}

function initialBonusStates(fixture: ScoringHandFixture): {
  readonly v1: CanonicalGameStateV1;
  readonly v2: CanonicalGameStateV2;
} {
  const winningTileId = fixture.winningTileId;
  const eastRaw = [...withoutWinningTile(fixture), tileId(136)];
  if (eastRaw.length !== 14)
    throw new Error("East raw deal must have 14 tiles.");
  const reserved = new Set<TileId>([...eastRaw, winningTileId]);
  const structural = createHongKongV1TileSet()
    .filter((tile) => tile.kind.type !== "bonus" && !reserved.has(tile.id))
    .map((tile) => tile.id);
  const hands = {
    east: fixture.concealedTileIds,
    south: structural.splice(0, 13),
    west: structural.splice(0, 13),
    north: structural.splice(0, 13),
  } satisfies SeatMap<readonly TileId[]>;
  const raw = {
    east: eastRaw,
    south: [...hands.south],
    west: [...hands.west],
    north: [...hands.north],
  } satisfies SeatMap<TileId[]>;
  const prefix = initialDealSeatOrder.map((assignedSeat) => {
    const id = raw[seatName(assignedSeat)].shift();
    if (id === undefined) throw new Error("Initial deal fixture ran dry.");
    return id;
  });
  if (Object.values(raw).some((ids) => ids.length !== 0)) {
    throw new Error("Initial deal fixture left undealt tiles.");
  }
  const occupied = new Set<TileId>([...prefix, winningTileId]);
  const live = createHongKongV1TileSet()
    .map((tile) => tile.id)
    .filter((id) => !occupied.has(id));
  const order = [...prefix, ...live, winningTileId];
  if (order.length !== 144) throw new Error("Initial wall must be complete.");
  const v1Players = Object.fromEntries(
    seats.map((currentSeat) => [
      currentSeat,
      {
        actorId: actors[seatName(currentSeat)],
        bonuses: currentSeat === seat("east") ? [tileId(136)] : [],
        discards: [],
        hand: hands[seatName(currentSeat)],
        seat: currentSeat,
      },
    ]),
  ) as unknown as CanonicalGameStateV1["players"];
  const v1: CanonicalGameStateV1 = {
    phase: "awaiting-dealer-discard",
    players: v1Players,
    ruleset: "hong-kong/v1",
    schemaVersion: 1,
    sequence: 1,
    shuffleAlgorithm: HONG_KONG_V1_SHUFFLE_ALGORITHM,
    turn: seat("east"),
    wall: { head: initialDealSeatOrder.length, order, tail: 142 },
  };
  const v2: CanonicalGameStateV2 = {
    ...v1,
    completionProvenance: null,
    players: Object.fromEntries(
      seats.map((currentSeat) => [
        currentSeat,
        { ...v1Players[seatName(currentSeat)], melds: [] },
      ]),
    ) as unknown as CanonicalGameStateV2["players"],
    prevailingWind: "east",
    reactionWindow: null,
    result: null,
    schemaVersion: 2,
    turnProvenance: {
      eastHasDeclaredKong: false,
      eastHasDiscarded: false,
      lastAcquiredTileId: winningTileId,
      lastAcquiredTileWasFinalWall: false,
      lastAcquisition: "bonus-replacement",
      replacementChainDepth: 0,
      replacementPending: false,
    },
  };
  assertGameInvariants(v1);
  assertGameInvariants(v2);
  return { v1, v2 };
}

describe("authoritative scored win integration", () => {
  it("completes an ambiguous self-pick in one replayable event batch", () => {
    const fixture = scoringFixture({
      concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 R R",
      melds: [{ kind: "pung", tiles: "E E E" }],
      source: { type: "self-pick" },
      winner: seat("west"),
      winningToken: "R",
    });
    const state = buildPreDiscardState({
      lastAcquiredTileId: fixture.winningTileId,
      placements: {
        [seat("west")]: {
          bonuses: fixture.bonusTileIds,
          hand: fixture.concealedTileIds,
          melds: fixture.declaredMelds,
        },
      },
      turn: seat("west"),
    });
    expect(
      projectGameV2(state, actors.west).viewerActions?.self,
    ).toContainEqual({ type: "game/declare-win" });
    const applied = applyGameCommandV2(state, actors.west, {
      type: "game/declare-win",
    });
    if (!applied.accepted || applied.state === undefined) {
      throw new Error("Legal self win was rejected.");
    }
    expect(applied.events.map((event) => event.type)).toEqual([
      "game/self-win-declared",
      "game/hand-completed",
    ]);
    expect(applied.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(applied.state).toMatchObject({
      phase: "complete",
      result: {
        decomposition: { kind: "standard" },
        source: { type: "self-pick" },
        winnerSeat: "west",
      },
    });
    expect(
      applied.state.result?.decomposition.kind === "standard"
        ? applied.state.result.decomposition.melds.every(
            (meld) => meld.kind === "pung",
          )
        : false,
    ).toBe(true);
    const genesis = {
      type: "game/started" as const,
      sequence: 1 as const,
      state,
    };
    const events: readonly VersionedHongKongGameEvent[] = [
      genesis,
      ...applied.events,
    ];
    for (const event of events) {
      expect(
        decodeCanonicalVersionedGameEventJson(
          canonicalVersionedGameEventJson(event),
        ),
      ).toEqual(event);
    }
    expect(replayVersionedGameEvents(events)).toEqual(applied.state);
    expect(
      decodeCanonicalVersionedGameJson(
        canonicalVersionedGameJson(applied.state),
      ),
    ).toEqual(applied.state);
    assertGameInvariants(applied.state);
  });

  it("scores every discard winner and selects highest faan before seat distance", () => {
    const sourceTileId = 125 as TileId;
    const west = scoringFixture({
      concealed: "c1 c1 c1 c1 c2 c3 c4 c5 c6 c7 c8 c9 R R",
      source: { type: "discard", sourceSeat: seat("south") },
      winner: seat("west"),
      winningToken: "R",
    });
    const northBase = scoringFixture({
      concealed: "b1 b2 b3 b4 b5 b6 b7 b8 b9 E E E R R",
      source: { type: "discard", sourceSeat: seat("south") },
      winner: seat("north"),
      winningToken: "R",
    });
    const north = withWinningCopy(northBase, 126 as TileId, sourceTileId);
    let state = openDiscard(
      {
        [seat("south")]: [sourceTileId],
        [seat("west")]: withoutWinningTile(west),
        [seat("north")]: withoutWinningTile(north),
      },
      seat("south"),
      sourceTileId,
    );
    const westIntent = submit(state, seat("west"), { type: "win" });
    if (!westIntent.accepted || westIntent.state === undefined) {
      throw new Error("West win intent failed.");
    }
    state = westIntent.state;
    const northIntent = submit(state, seat("north"), { type: "win" });
    if (!northIntent.accepted || northIntent.state === undefined) {
      throw new Error("North win intent failed.");
    }
    state = northIntent.state;
    const final = submit(state, seat("east"), { type: "pass" });
    if (!final.accepted || final.state === undefined) {
      throw new Error("Final reaction failed.");
    }
    expect(final.events.map((event) => event.type)).toEqual([
      "game/reaction-intent-submitted",
      "game/reaction-resolved",
      "game/hand-completed",
    ]);
    expect(final.events.map((event) => event.sequence)).toEqual([
      state.sequence + 1,
      state.sequence + 2,
      state.sequence + 3,
    ]);
    expect(final.state.result).toMatchObject({
      cappedFaan: 6,
      source: { sourceSeat: "south", type: "discard" },
      winnerSeat: "north",
    });
    expect(final.state.players.south.discards).not.toContain(sourceTileId);
    expect(final.state.players.north.hand).toContain(sourceTileId);
    const spectator = projectGameV2(final.state, "actor:spectator");
    expect(spectator.result?.winnerSeat).toBe("north");
    const spectatorBytes = JSON.stringify(spectator);
    expect(spectatorBytes).not.toContain("actor:west");
    expect(spectatorBytes).not.toContain('"cappedFaan":5');
    assertGameInvariants(final.state);
  });

  it("breaks equal capped-faan discard wins by nearest seat", () => {
    const sourceTileId = 125 as TileId;
    const west = scoringFixture({
      concealed: "c1 c1 c1 c1 c2 c3 c4 c5 c6 c7 c8 c9 R R",
      source: { type: "discard", sourceSeat: seat("south") },
      winner: seat("west"),
      winningToken: "R",
    });
    const northBase = scoringFixture({
      concealed: "o1 o1 o1 o1 o2 o3 o4 o5 o6 o7 o8 o9 R R",
      source: { type: "discard", sourceSeat: seat("south") },
      winner: seat("north"),
      winningToken: "R",
    });
    const north = withWinningCopy(northBase, 126 as TileId, sourceTileId);
    const initial = (): CanonicalGameStateV2 =>
      openDiscard(
        {
          [seat("south")]: [sourceTileId],
          [seat("west")]: withoutWinningTile(west),
          [seat("north")]: withoutWinningTile(north),
        },
        seat("south"),
        sourceTileId,
      );
    const resolveOrder = (
      order: readonly Seat[],
    ): {
      readonly events: readonly VersionedHongKongGameEvent[];
      readonly state: CanonicalGameStateV2;
    } => {
      let state = initial();
      for (const responder of order) {
        const result = submit(state, responder, { type: "win" });
        if (!result.accepted || result.state === undefined) {
          throw new Error("Tie fixture win intent failed.");
        }
        state = result.state;
      }
      const final = submit(state, seat("east"), { type: "pass" });
      if (!final.accepted || final.state === undefined) {
        throw new Error("Tie fixture did not resolve.");
      }
      return { events: final.events, state: final.state };
    };
    const northFirst = resolveOrder([seat("north"), seat("west")]);
    const westFirst = resolveOrder([seat("west"), seat("north")]);
    expect(northFirst.state.result).toMatchObject({
      cappedFaan: 5,
      winnerSeat: "west",
    });
    expect(canonicalVersionedGameJson(westFirst.state)).toBe(
      canonicalVersionedGameJson(northFirst.state),
    );
    expect(westFirst.events.map(canonicalVersionedGameEventJson)).toEqual(
      northFirst.events.map(canonicalVersionedGameEventJson),
    );
  });

  it("rejects low-faan and false structures without consuming the response", () => {
    const low = scoringFixture({
      concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
      source: { type: "discard", sourceSeat: seat("south") },
      winner: seat("west"),
      winningToken: "R",
    });
    const sourceTileId = low.winningTileId;
    const state = openDiscard(
      {
        [seat("south")]: [sourceTileId],
        [seat("west")]: withoutWinningTile(low),
      },
      seat("south"),
      sourceTileId,
    );
    expect(
      projectGameV2(state, actors.west).viewerActions?.reaction?.actions,
    ).not.toContainEqual({ type: "win" });
    expect(submit(state, seat("west"), { type: "win" })).toMatchObject({
      accepted: false,
      error: { code: "win-not-allowed" },
    });
    expect(submit(state, seat("west"), { type: "pass" })).toMatchObject({
      accepted: true,
    });

    const invalidFixture = scoringFixture({
      concealed: "c1 c2 c4 c5 c7 c8 o1 o2 o4 o5 b1 b2 E R",
      source: { type: "self-pick" },
      winner: seat("south"),
      winningToken: "R",
    });
    const falseStructure = buildPreDiscardState({
      lastAcquiredTileId: invalidFixture.winningTileId,
      placements: {
        south: { hand: invalidFixture.concealedTileIds },
      },
      turn: seat("south"),
    });
    expect(
      applyGameCommandV2(falseStructure, actors.south, {
        type: "game/declare-win",
      }),
    ).toMatchObject({
      accepted: false,
      error: { code: "win-not-allowed" },
    });
  });

  it("rejects forged completions and never serializes a pending checkpoint", () => {
    const fixture = scoringFixture({
      concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 c4 c4 c4 c5 c5",
      source: { type: "self-pick" },
      winner: seat("west"),
      winningToken: "c5",
    });
    const state = buildPreDiscardState({
      lastAcquiredTileId: fixture.winningTileId,
      placements: { [seat("west")]: { hand: fixture.concealedTileIds } },
      turn: seat("west"),
    });
    const decision = applyGameCommandV2(state, actors.west, {
      type: "game/declare-win",
    });
    if (!decision.accepted) throw new Error("Fixture win failed.");
    const declaration = decision.events[0];
    const completion = decision.events[1];
    if (
      declaration.type !== "game/self-win-declared" ||
      completion?.type !== "game/hand-completed"
    ) {
      throw new Error("Fixture win batch is incomplete.");
    }
    const pending = reduceVersionedGameEvent(state, declaration);
    if (pending.schemaVersion !== 2)
      throw new Error("Pending state is legacy.");
    expect(pending.phase).toBe("pending-win-validation");
    expect(() => canonicalVersionedGameJson(pending)).toThrow(
      /implementation-only/iu,
    );
    expect(() => projectGameV2(pending, actors.west)).toThrow(
      /implementation-only/iu,
    );
    expect(() =>
      reduceVersionedGameEvent(pending, {
        ...completion,
        result: { ...completion.result, tablePoints: 999 },
      }),
    ).toThrow();
    const final = reduceVersionedGameEvent(pending, completion);
    expect(final).toEqual(decision.state);
    assertGameInvariants(final);
  });

  it("keeps robbed added-kong provenance and payments in the final result", () => {
    const sourceTileId = 7 as TileId;
    const winningWait = [
      0, 8, 36, 37, 38, 40, 41, 42, 44, 45, 46, 108, 109,
    ].map(tileId);
    const pung: DeclaredMeld = {
      claimedTileId: 4 as TileId,
      exposure: "exposed",
      id: "meld:bamboo-two-pung",
      kind: "pung",
      sourceSeat: seat("east"),
      tileIds: [4, 5, 6].map(tileId),
    };
    let state = buildPreDiscardState({
      lastAcquiredTileId: sourceTileId,
      placements: {
        [seat("south")]: { hand: [sourceTileId], melds: [pung] },
        [seat("west")]: { hand: winningWait },
      },
      turn: seat("south"),
    });
    const proposal = applyGameCommandV2(state, actors.south, {
      type: "game/propose-added-kong",
      meldId: pung.id,
      tileId: sourceTileId,
    });
    if (!proposal.accepted || proposal.state === undefined) {
      throw new Error("Added kong fixture failed.");
    }
    state = proposal.state;
    const intent = submit(state, seat("west"), { type: "win" });
    if (!intent.accepted || intent.state === undefined) {
      throw new Error("Rob intent failed.");
    }
    const resolution = decideReactionExpiration(intent.state);
    if (!resolution.accepted) throw new Error("Rob resolution failed.");
    state = intent.state;
    for (const event of resolution.events) {
      state = reduceVersionedGameEvent(state, event) as CanonicalGameStateV2;
    }
    expect(state.result).toMatchObject({
      source: { sourceSeat: "south", type: "robbing-kong" },
      winnerSeat: "west",
    });
    if (state.result === null) throw new Error("Rob score is absent.");
    expect(state.result.awardedPatterns).toContainEqual(
      expect.objectContaining({ id: "robbing-kong" }),
    );
    expect(state.players.south.melds[0]).toEqual(pung);
    expect(state.players.south.hand).not.toContain(sourceTileId);
    expect(state.players.west.hand).toContain(sourceTileId);
    const payments = state.result.payments;
    expect(
      payments.east + payments.south + payments.west + payments.north,
    ).toBe(0);
    assertGameInvariants(state);
  });

  it("tracks the actual final wall draw through self-pick and its immediate discard", () => {
    const selfFixture = scoringFixture({
      concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 c4 c4 c4 c5 c5",
      source: { type: "self-pick" },
      winner: seat("west"),
      winningToken: "c5",
    });
    let selfState = buildPreDiscardState({
      lastAcquiredTileId: null,
      phase: "awaiting-draw",
      placements: {
        west: { hand: withoutWinningTile(selfFixture) },
      },
      turn: seat("west"),
      wallFinalTileId: selfFixture.winningTileId,
    });
    const drawn = applyGameCommandV2(selfState, actors.west, {
      type: "game/draw",
    });
    if (!drawn.accepted || drawn.state === undefined) {
      throw new Error("Final draw failed.");
    }
    selfState = drawn.state;
    expect(selfState.turnProvenance).toMatchObject({
      lastAcquiredTileWasFinalWall: true,
      lastAcquisition: "draw",
    });
    const selfWin = applyGameCommandV2(selfState, actors.west, {
      type: "game/declare-win",
    });
    if (!selfWin.accepted || selfWin.state === undefined) {
      throw new Error("Final-wall self win failed.");
    }
    expect(selfWin.state.result).toMatchObject({
      winningConditions: { wallPosition: "final-wall-tile" },
    });
    expect(selfWin.state.result?.awardedPatterns).toContainEqual(
      expect.objectContaining({ id: "last-catch" }),
    );

    const sourceTileId = 125 as TileId;
    const discardFixture = scoringFixture({
      concealed: "c1 c1 c1 c1 c2 c3 c4 c5 c6 c7 c8 c9 R R",
      source: { type: "discard", sourceSeat: seat("south") },
      winner: seat("west"),
      winningToken: "R",
    });
    let discardState = buildPreDiscardState({
      lastAcquiredTileId: null,
      phase: "awaiting-draw",
      placements: { west: { hand: withoutWinningTile(discardFixture) } },
      turn: seat("south"),
      wallFinalTileId: sourceTileId,
    });
    const sourceDraw = applyGameCommandV2(discardState, actors.south, {
      type: "game/draw",
    });
    if (!sourceDraw.accepted || sourceDraw.state === undefined) {
      throw new Error("Source final draw failed.");
    }
    const opened = applyGameCommandV2(sourceDraw.state, actors.south, {
      type: "game/discard",
      tileId: sourceTileId,
    });
    if (!opened.accepted || opened.state === undefined) {
      throw new Error("Immediate final discard failed.");
    }
    expect(opened.state.reactionWindow?.sourceLastCatch).toBe(true);
    const intent = submit(opened.state, seat("west"), { type: "win" });
    if (!intent.accepted || intent.state === undefined) {
      throw new Error("Immediate final-discard win failed.");
    }
    discardState = expireReactions(intent.state);
    expect(discardState.result).toMatchObject({
      winningConditions: {
        wallPosition: "discard-after-final-wall-tile",
      },
    });
  });

  it("clears Last Catch after a claim before the later no-draw discard", () => {
    const finalTileId = 7 as TileId;
    const laterDiscardId = 125 as TileId;
    const northBase = scoringFixture({
      concealed: "b1 b2 b3 b4 b5 b6 b7 b8 b9 E E E R R",
      source: { type: "discard", sourceSeat: seat("west") },
      winner: seat("north"),
      winningToken: "R",
    });
    const north = withWinningCopy(northBase, 126 as TileId, laterDiscardId);
    let state = buildPreDiscardState({
      lastAcquiredTileId: null,
      phase: "awaiting-draw",
      placements: {
        north: { hand: withoutWinningTile(north) },
        west: { hand: [tileId(5), tileId(6), laterDiscardId] },
      },
      turn: seat("south"),
      wallFinalTileId: finalTileId,
    });
    const drawn = applyGameCommandV2(state, actors.south, {
      type: "game/draw",
    });
    if (!drawn.accepted || drawn.state === undefined)
      throw new Error("Draw failed.");
    const opened = applyGameCommandV2(drawn.state, actors.south, {
      type: "game/discard",
      tileId: finalTileId,
    });
    if (!opened.accepted || opened.state === undefined)
      throw new Error("Discard failed.");
    state = opened.state;
    const pung = applyGameCommandV2(state, actors.west, {
      type: "game/react",
      response: {
        type: "pung",
        handTileIds: [tileId(5), tileId(6)],
      },
      windowId: state.reactionWindow?.id ?? "missing",
    });
    if (!pung.accepted || pung.state === undefined)
      throw new Error("Pung failed.");
    state = pung.state;
    for (const responder of [seat("north"), seat("east")]) {
      const passed = submit(state, responder, { type: "pass" });
      if (!passed.accepted || passed.state === undefined)
        throw new Error("Pass failed.");
      state = passed.state;
    }
    expect(state.phase).toBe("awaiting-discard");
    const later = applyGameCommandV2(state, actors.west, {
      type: "game/discard",
      tileId: laterDiscardId,
    });
    if (!later.accepted || later.state === undefined)
      throw new Error("Later discard failed.");
    expect(later.state.reactionWindow?.sourceLastCatch).toBe(false);
    const northIntent = submit(later.state, seat("north"), { type: "win" });
    if (!northIntent.accepted || northIntent.state === undefined)
      throw new Error("North win failed.");
    const complete = expireReactions(northIntent.state);
    expect(complete.result?.winningConditions.wallPosition).toBe("ordinary");
    expect(complete.result?.detectedPatterns).not.toContainEqual(
      expect.objectContaining({ id: "last-catch" }),
    );
  });

  it("awards Last Catch when the exact final tile proposes a robbed added kong", () => {
    const sourceTileId = 7 as TileId;
    const pung: DeclaredMeld = {
      claimedTileId: 4 as TileId,
      exposure: "exposed",
      id: "meld:final-added",
      kind: "pung",
      sourceSeat: seat("east"),
      tileIds: [4, 5, 6].map(tileId),
    };
    const winningWait = [
      0, 8, 36, 37, 38, 40, 41, 42, 44, 45, 46, 108, 109,
    ].map(tileId);
    let state = buildPreDiscardState({
      lastAcquiredTileId: null,
      phase: "awaiting-draw",
      placements: {
        south: { melds: [pung] },
        west: { hand: winningWait },
      },
      turn: seat("south"),
      wallFinalTileId: sourceTileId,
    });
    const drawn = applyGameCommandV2(state, actors.south, {
      type: "game/draw",
    });
    if (!drawn.accepted || drawn.state === undefined)
      throw new Error("Final draw failed.");
    const proposal = applyGameCommandV2(drawn.state, actors.south, {
      type: "game/propose-added-kong",
      meldId: pung.id,
      tileId: sourceTileId,
    });
    if (!proposal.accepted || proposal.state === undefined)
      throw new Error("Proposal failed.");
    expect(proposal.state.reactionWindow?.sourceLastCatch).toBe(true);
    const win = submit(proposal.state, seat("west"), { type: "win" });
    if (!win.accepted || win.state === undefined)
      throw new Error("Rob failed.");
    state = expireReactions(win.state);
    expect(state.result).toMatchObject({
      source: { type: "robbing-kong" },
      winningConditions: { wallPosition: "final-wall-tile" },
    });
    expect(state.result?.awardedPatterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "last-catch" }),
        expect.objectContaining({ id: "robbing-kong" }),
      ]),
    );
  });

  it("counts only a kong formed with the prior kong replacement as Double Kong", () => {
    const firstKong: DeclaredMeld = {
      exposure: "concealed",
      id: "meld:first-kong",
      kind: "kong",
      kongKind: "concealed",
      tileIds: [0, 1, 2, 3].map(tileId),
    };
    const secondKongIds = [4, 5, 6, 7].map(tileId) as [
      TileId,
      TileId,
      TileId,
      TileId,
    ];
    const baseHand = [
      ...secondKongIds,
      ...[36, 40, 44, 48, 52, 56, 124].map(tileId),
    ];
    const run = (linked: boolean): CanonicalGameStateV2 => {
      let state = buildPreDiscardState({
        lastAcquiredTileId: linked ? tileId(7) : tileId(36),
        lastAcquisition: "kong-replacement",
        placements: {
          west: { hand: baseHand, melds: [firstKong] },
        },
        replacementChainDepth: 1,
        turn: seat("west"),
      });
      state = putWallTileAtTail(state, tileId(125));
      const declared = applyGameCommandV2(state, actors.west, {
        type: "game/declare-concealed-kong",
        tileIds: secondKongIds,
      });
      if (!declared.accepted || declared.state === undefined) {
        throw new Error("Second kong failed.");
      }
      expect(declared.state.turnProvenance.replacementChainDepth).toBe(
        linked ? 2 : 1,
      );
      const won = applyGameCommandV2(declared.state, actors.west, {
        type: "game/declare-win",
      });
      if (!won.accepted || won.state === undefined)
        throw new Error("Replacement win failed.");
      return won.state;
    };
    const linked = run(true);
    expect(linked.result?.winningConditions.replacement).toBe("double-kong");
    expect(linked.result?.awardedPatterns).toContainEqual(
      expect.objectContaining({ id: "double-kong-win" }),
    );
    const unrelated = run(false);
    expect(unrelated.result?.winningConditions.replacement).toBe("kong");
    expect(unrelated.result?.detectedPatterns).not.toContainEqual(
      expect.objectContaining({ id: "double-kong-win" }),
    );
  });

  it("records the actual East bonus replacement in fresh setup and initial v1 upgrade", () => {
    const offset = Array.from({ length: 256 }, (_, index) => index).find(
      (candidate) =>
        startHongKongV2Game(actors, randomness(candidate)).state.players.east
          .bonuses.length > 0,
    );
    if (offset === undefined)
      throw new Error("No seeded East bonus deal found.");
    const fresh = startHongKongV2Game(actors, randomness(offset));
    expect(fresh.state.turnProvenance).toMatchObject({
      lastAcquisition: "bonus-replacement",
    });
    expect(fresh.state.players.east.hand).toContain(
      fresh.state.turnProvenance.lastAcquiredTileId,
    );
    expect(replayVersionedGameEvents([fresh.event])).toEqual(fresh.state);

    const legacy = startHongKongV1Game(actors, randomness(offset));
    const upgrade = createStateUpgradeEvent([legacy.event]);
    const upgraded = reduceVersionedGameEvent(legacy.state, upgrade);
    if (upgraded.schemaVersion !== 2) throw new Error("Upgrade stayed legacy.");
    expect(upgraded.turnProvenance).toMatchObject({
      lastAcquiredTileId: fresh.state.turnProvenance.lastAcquiredTileId,
      lastAcquisition: "bonus-replacement",
    });
    expect(replayVersionedGameEvents([legacy.event, upgrade])).toEqual(
      upgraded,
    );
  });

  it("scores and replays Heavenly Hand after fresh and upgraded initial bonus replacement", () => {
    const fixture = scoringFixture({
      bonuses: [136],
      concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 c4 c4 c4 c5 c5",
      source: { type: "self-pick" },
      winner: seat("east"),
      winningToken: "c5",
    });
    const initial = initialBonusStates(fixture);
    const cases: readonly {
      readonly events: readonly VersionedHongKongGameEvent[];
      readonly state: CanonicalGameStateV2;
    }[] = [
      {
        events: [{ sequence: 1, state: initial.v2, type: "game/started" }],
        state: initial.v2,
      },
      (() => {
        const genesis = {
          sequence: 1 as const,
          state: initial.v1,
          type: "game/started" as const,
        };
        const upgrade = createStateUpgradeEvent([genesis]);
        const state = reduceVersionedGameEvent(initial.v1, upgrade);
        if (state.schemaVersion !== 2)
          throw new Error("Upgrade stayed legacy.");
        return { events: [genesis, upgrade], state };
      })(),
    ];
    for (const testCase of cases) {
      const won = applyGameCommandV2(testCase.state, actors.east, {
        type: "game/declare-win",
      });
      if (!won.accepted || won.state === undefined) {
        throw new Error("Initial replacement win failed.");
      }
      expect(won.state.result?.winningConditions).toEqual({
        opening: "heavenly",
        replacement: "bonus",
        wallPosition: "ordinary",
      });
      expect(won.state.result?.detectedPatterns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "heavenly-hand" }),
          expect.objectContaining({ id: "replacement-win" }),
        ]),
      );
      expect(won.state.result?.awardedPatterns).toContainEqual(
        expect.objectContaining({ id: "heavenly-hand" }),
      );
      expect(
        won.state.result?.suppressedPatterns.some(
          ({ pattern }) => pattern.id === "replacement-win",
        ),
      ).toBe(true);
      const allEvents = [...testCase.events, ...won.events];
      for (const event of allEvents) {
        expect(
          decodeCanonicalVersionedGameEventJson(
            canonicalVersionedGameEventJson(event),
          ),
        ).toEqual(event);
      }
      expect(replayVersionedGameEvents(allEvents)).toEqual(won.state);
    }
  });

  it("awards Earthly Hand only on East's actual opening discard", () => {
    const sourceTileId = tileId(125);
    const fixture = scoringFixture({
      concealed: "c1 c1 c1 c1 c2 c3 c4 c5 c6 c7 c8 c9 R R",
      source: { sourceSeat: seat("east"), type: "discard" },
      winner: seat("south"),
      winningToken: "R",
    });
    const run = (eastHasDiscarded: boolean): CanonicalGameStateV2 => {
      const state = buildPreDiscardState({
        eastHasDiscarded,
        lastAcquiredTileId: sourceTileId,
        lastAcquisition: eastHasDiscarded ? "draw" : "deal",
        phase: eastHasDiscarded
          ? "awaiting-discard"
          : "awaiting-dealer-discard",
        placements: {
          east: { hand: [sourceTileId] },
          south: { hand: withoutWinningTile(fixture) },
        },
        turn: seat("east"),
      });
      const opened = applyGameCommandV2(state, actors.east, {
        tileId: sourceTileId,
        type: "game/discard",
      });
      if (!opened.accepted || opened.state === undefined) {
        throw new Error("East discard failed.");
      }
      expect(opened.state.reactionWindow?.sourceIsOpeningEastDiscard).toBe(
        !eastHasDiscarded,
      );
      const intent = submit(opened.state, seat("south"), { type: "win" });
      if (!intent.accepted || intent.state === undefined) {
        throw new Error("South win failed.");
      }
      return expireReactions(intent.state);
    };
    const opening = run(false);
    expect(opening.result?.winningConditions.opening).toBe("earthly");
    expect(opening.result?.awardedPatterns).toContainEqual(
      expect.objectContaining({ id: "earthly-hand" }),
    );
    const later = run(true);
    expect(later.result?.winningConditions.opening).toBe("none");
    expect(later.result?.detectedPatterns).not.toContainEqual(
      expect.objectContaining({ id: "earthly-hand" }),
    );
  });

  it("rejects independently re-scored terminal source, condition, and payment forgeries", () => {
    const base = scoringFixture({
      bonuses: [136],
      concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 c4 c4 c4 c5 c5",
      source: { type: "self-pick" },
      winner: seat("west"),
      winningToken: "c5",
    });
    const state = buildPreDiscardState({
      lastAcquiredTileId: base.winningTileId,
      placements: {
        west: { bonuses: base.bonusTileIds, hand: base.concealedTileIds },
      },
      turn: seat("west"),
    });
    const won = applyGameCommandV2(state, actors.west, {
      type: "game/declare-win",
    });
    if (
      !won.accepted ||
      won.state?.result === null ||
      won.state === undefined
    ) {
      throw new Error("Forgery base win failed.");
    }
    const variants = [
      createScoringHandFixture({
        ...base,
        winningTileSource: { sourceSeat: seat("east"), type: "discard" },
      }),
      createScoringHandFixture({
        ...base,
        winningConditions: { wallPosition: "final-wall-tile" },
      }),
      createScoringHandFixture({
        ...base,
        winningConditions: { replacement: "bonus" },
      }),
    ] as const;
    for (const fixture of variants) {
      const forgedResult = completedResultForFixture(fixture);
      const forged = {
        ...won.state,
        result: forgedResult,
      };
      expect(() => {
        assertGameInvariants(forged);
      }).toThrow(/provenance/iu);
      expect(() =>
        decodeCanonicalVersionedGameJson(canonicalJson(forged)),
      ).toThrow(/provenance/iu);
    }
    const provenance = won.state.completionProvenance;
    if (provenance?.kind !== "self-pick") {
      throw new Error("Forgery base lacks self-pick provenance.");
    }
    const coherentForgeries: readonly CanonicalGameStateV2[] = [
      {
        ...won.state,
        completionProvenance: {
          ...provenance,
          acquiredTileWasFinalWall: true,
        },
        result: completedResultForFixture(variants[1]),
        turnProvenance: {
          ...won.state.turnProvenance,
          lastAcquiredTileWasFinalWall: true,
        },
      },
      {
        ...won.state,
        completionProvenance: {
          ...provenance,
          lastAcquisition: "bonus-replacement",
        },
        result: completedResultForFixture(variants[2]),
        turnProvenance: {
          ...won.state.turnProvenance,
          lastAcquisition: "bonus-replacement",
        },
      },
    ];
    for (const forged of coherentForgeries) {
      expect(() => {
        assertGameInvariants(forged);
      }).toThrow();
      expect(() =>
        decodeCanonicalVersionedGameJson(canonicalJson(forged)),
      ).toThrow();
    }
  });

  it("requires event replay to reject a fully coherent alternate source checkpoint", () => {
    const sourceTileId = tileId(125);
    const actualFixture = scoringFixture({
      concealed: "c1 c1 c1 c1 c2 c3 c4 c5 c6 c7 c8 c9 R R",
      source: { sourceSeat: seat("south"), type: "discard" },
      winner: seat("west"),
      winningToken: "R",
    });
    const initial = buildPreDiscardState({
      lastAcquiredTileId: sourceTileId,
      placements: {
        south: { hand: [sourceTileId] },
        west: { hand: withoutWinningTile(actualFixture) },
      },
      turn: seat("south"),
    });
    const genesis: VersionedHongKongGameEvent = {
      sequence: 1,
      state: initial,
      type: "game/started",
    };
    const opened = applyGameCommandV2(initial, actors.south, {
      tileId: sourceTileId,
      type: "game/discard",
    });
    if (!opened.accepted || opened.state === undefined) {
      throw new Error("Source checkpoint discard failed.");
    }
    const intent = submit(opened.state, seat("west"), { type: "win" });
    if (!intent.accepted || intent.state === undefined) {
      throw new Error("Source checkpoint win failed.");
    }
    const resolution = decideReactionExpiration(intent.state);
    if (!resolution.accepted)
      throw new Error("Source checkpoint expiry failed.");
    let actual = intent.state;
    for (const event of resolution.events) {
      actual = reduceVersionedGameEvent(actual, event) as CanonicalGameStateV2;
    }
    const events = [
      genesis,
      ...opened.events,
      ...intent.events,
      ...resolution.events,
    ];
    assertVersionedCheckpointMatchesReplay(events, actual);
    const alternateFixture = createScoringHandFixture({
      ...actualFixture,
      winningTileSource: { sourceSeat: seat("east"), type: "discard" },
    });
    const alternate: CanonicalGameStateV2 = {
      ...actual,
      completionProvenance: {
        kind: "discard",
        sourceIsOpeningEastDiscard: false,
        sourceLastCatch: false,
        sourceSeat: seat("east"),
        winnerSeat: seat("west"),
        winningTileId: sourceTileId,
      },
      result: completedResultForFixture(alternateFixture),
    };
    const alternateBytes = canonicalJson(alternate);
    expect(decodeCanonicalVersionedGameJson(alternateBytes)).toEqual(alternate);
    expect(alternateBytes).not.toBe(canonicalVersionedGameJson(actual));
    expect(() => {
      assertVersionedCheckpointMatchesReplay(events, alternate);
    }).toThrow(/diverges from event replay/iu);
  });

  it("requires event replay to reject a coherent opening-window flag rewrite", () => {
    const sourceTileId = tileId(125);
    const initial = buildPreDiscardState({
      eastHasDiscarded: false,
      lastAcquiredTileId: sourceTileId,
      lastAcquisition: "deal",
      phase: "awaiting-dealer-discard",
      placements: { east: { hand: [sourceTileId] } },
      turn: seat("east"),
    });
    const genesis: VersionedHongKongGameEvent = {
      sequence: 1,
      state: initial,
      type: "game/started",
    };
    const opened = applyGameCommandV2(initial, actors.east, {
      tileId: sourceTileId,
      type: "game/discard",
    });
    if (!opened.accepted || opened.state === undefined) {
      throw new Error("Opening-window fixture failed.");
    }
    if (opened.state.reactionWindow === null) {
      throw new Error("Opening-window fixture lacks its reaction window.");
    }
    expect(opened.state.reactionWindow.sourceIsOpeningEastDiscard).toBe(true);
    const forged: CanonicalGameStateV2 = {
      ...opened.state,
      reactionWindow: {
        ...opened.state.reactionWindow,
        sourceIsOpeningEastDiscard: false,
      },
    };
    expect(decodeCanonicalVersionedGameJson(canonicalJson(forged))).toEqual(
      forged,
    );
    const events = [genesis, ...opened.events];
    assertVersionedCheckpointMatchesReplay(events, opened.state);
    expect(() => {
      assertVersionedCheckpointMatchesReplay(events, forged);
    }).toThrow(/diverges from event replay/iu);
  });

  it("runs deterministic win-inclusive reaction simulations with replay checks", () => {
    const sourceTileId = tileId(125);
    const fixture = scoringFixture({
      concealed: "c1 c1 c1 c1 c2 c3 c4 c5 c6 c7 c8 c9 R R",
      source: { sourceSeat: seat("east"), type: "discard" },
      winner: seat("west"),
      winningToken: "R",
    });
    const orders: readonly (readonly Seat[])[] = [
      [seat("south"), seat("west"), seat("north")],
      [seat("south"), seat("north"), seat("west")],
      [seat("west"), seat("south"), seat("north")],
      [seat("west"), seat("north"), seat("south")],
      [seat("north"), seat("south"), seat("west")],
      [seat("north"), seat("west"), seat("south")],
    ];
    const terminals = orders.map((order) => {
      const initial = buildPreDiscardState({
        lastAcquiredTileId: sourceTileId,
        placements: {
          east: { hand: [sourceTileId] },
          west: { hand: withoutWinningTile(fixture) },
        },
        turn: seat("east"),
      });
      const genesis: VersionedHongKongGameEvent = {
        sequence: 1,
        state: initial,
        type: "game/started",
      };
      const opened = applyGameCommandV2(initial, actors.east, {
        tileId: sourceTileId,
        type: "game/discard",
      });
      if (!opened.accepted || opened.state === undefined) {
        throw new Error("Simulation discard failed.");
      }
      let state = opened.state;
      const events = [genesis, ...opened.events];
      for (const responder of order) {
        const response = submit(
          state,
          responder,
          responder === seat("west") ? { type: "win" } : { type: "pass" },
        );
        if (!response.accepted || response.state === undefined) {
          throw new Error("Simulation response failed.");
        }
        state = response.state;
        events.push(...response.events);
      }
      expect(state.phase).toBe("complete");
      for (const event of events) {
        expect(
          decodeCanonicalVersionedGameEventJson(
            canonicalVersionedGameEventJson(event),
          ),
        ).toEqual(event);
      }
      expect(replayVersionedGameEvents(events)).toEqual(state);
      return canonicalVersionedGameJson(state);
    });
    expect(new Set(terminals).size).toBe(1);
  });
});
