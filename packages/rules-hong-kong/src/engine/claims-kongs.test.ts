import { seat, seats, type Seat, type TileId } from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import { legalReactionsForSeat } from "../claims/legal-reactions.js";
import { normalizeReactionWindow } from "../claims/reaction-resolution.js";
import type { ReactionResponse, SeatMap } from "./game-state.js";
import {
  applyGameCommandV2 as applyGameCommand,
  assertGameInvariants,
  canonicalVersionedGameEventJson as canonicalGameEventJson,
  canonicalVersionedGameJson as canonicalGameJson,
  decodeCanonicalVersionedGameEventJson as decodeCanonicalGameEventJson,
  decodeCanonicalVersionedGameJson as decodeCanonicalGameJson,
  decideReactionExpiration,
  projectGameV2 as projectGame,
  reduceVersionedGameEvent as reduceGameEvent,
  replayVersionedGameEvents as replayGameEvents,
  startHongKongV2Game as startHongKongV1Game,
  type CanonicalGameStateV2,
  type VersionedHongKongGameEvent as HongKongGameEvent,
} from "./hong-kong-game.js";

const actors: SeatMap<string> = {
  east: "actor:east",
  south: "actor:south",
  west: "actor:west",
  north: "actor:north",
};

function randomness(offset: number): Uint8Array {
  return Uint8Array.from(
    { length: 1_028 },
    (_, index) => (index * 73 + offset) & 0xff,
  );
}

function swapEverywhere(
  state: CanonicalGameStateV2,
  left: TileId,
  right: TileId,
): CanonicalGameStateV2 {
  const swap = (id: TileId): TileId =>
    id === left ? right : id === right ? left : id;
  return {
    ...state,
    players: Object.fromEntries(
      seats.map((currentSeat) => {
        const player = state.players[currentSeat as keyof SeatMap<unknown>];
        return [
          currentSeat,
          {
            ...player,
            bonuses: player.bonuses.map(swap),
            discards: player.discards.map(swap),
            hand: player.hand.map(swap),
            melds: player.melds.map((meld) => ({
              ...meld,
              ...(meld.claimedTileId === undefined
                ? {}
                : { claimedTileId: swap(meld.claimedTileId) }),
              tileIds: meld.tileIds
                .map(swap)
                .sort((a, b) => Number(a) - Number(b)),
            })),
          },
        ];
      }),
    ) as unknown as CanonicalGameStateV2["players"],
    reactionWindow:
      state.reactionWindow === null
        ? null
        : {
            ...state.reactionWindow,
            sourceTileId: swap(state.reactionWindow.sourceTileId),
          },
    turnProvenance: {
      ...state.turnProvenance,
      lastAcquiredTileId:
        state.turnProvenance.lastAcquiredTileId === null
          ? null
          : swap(state.turnProvenance.lastAcquiredTileId),
    },
    wall: { ...state.wall, order: state.wall.order.map(swap) },
  };
}

function placeInHands(
  state: CanonicalGameStateV2,
  placements: readonly {
    readonly index: number;
    readonly seat: Seat;
    readonly tileId: TileId;
  }[],
): CanonicalGameStateV2 {
  let next = state;
  for (const placement of placements) {
    const current =
      next.players[placement.seat as keyof SeatMap<unknown>].hand[
        placement.index
      ];
    if (current === undefined) throw new Error("Fixture hand slot is absent.");
    next = swapEverywhere(next, current, placement.tileId);
  }
  assertGameInvariants(next);
  return next;
}

function openDiscard(
  state: CanonicalGameStateV2,
  tileId: TileId,
): {
  readonly events: readonly HongKongGameEvent[];
  readonly state: CanonicalGameStateV2;
} {
  const actor = state.players[state.turn as keyof SeatMap<unknown>].actorId;
  const result = applyGameCommand(state, actor, {
    type: "game/discard",
    tileId,
  });
  if (!result.accepted || result.state === undefined) {
    throw new Error("Fixture discard was rejected.");
  }
  return { events: result.events, state: result.state };
}

function respond(
  state: CanonicalGameStateV2,
  responder: Seat,
  response: ReactionResponse,
): {
  readonly events: readonly HongKongGameEvent[];
  readonly state: CanonicalGameStateV2;
} {
  if (state.reactionWindow === null) throw new Error("No fixture window.");
  const result = applyGameCommand(
    state,
    state.players[responder as keyof SeatMap<unknown>].actorId,
    { type: "game/react", response, windowId: state.reactionWindow.id },
  );
  if (!result.accepted || result.state === undefined) {
    throw new Error(`Fixture response was rejected: ${response.type}.`);
  }
  return { events: result.events, state: result.state };
}

function resolvePasses(state: CanonicalGameStateV2): CanonicalGameStateV2 {
  const decision = decideReactionExpiration(state);
  if (!decision.accepted) throw new Error("Fixture reaction expiry failed.");
  let next = state;
  for (const event of decision.events) {
    next = reduceGameEvent(next, event) as CanonicalGameStateV2;
  }
  return next;
}

describe("canonical schema-v2 claims and kongs", () => {
  it("starts explicit v2 games and round-trips their genesis", () => {
    const started = startHongKongV1Game(actors, randomness(201));
    expect(started.state.schemaVersion).toBe(2);
    expect(decodeCanonicalGameJson(canonicalGameJson(started.state))).toEqual(
      started.state,
    );
    expect(
      decodeCanonicalGameEventJson(canonicalGameEventJson(started.event)),
    ).toEqual(started.event);
    expect(replayGameEvents([started.event])).toEqual(started.state);
    expect(projectGame(started.state, actors.east).phase).toBe(
      "awaiting-dealer-discard",
    );
  });

  it("enumerates exact chow, pung, and exposed-kong actions", () => {
    let state = placeInHands(
      startHongKongV1Game(actors, randomness(202)).state,
      [
        { index: 0, seat: seat("east"), tileId: 4 as TileId },
        { index: 0, seat: seat("south"), tileId: 0 as TileId },
        { index: 1, seat: seat("south"), tileId: 8 as TileId },
        { index: 0, seat: seat("west"), tileId: 5 as TileId },
        { index: 1, seat: seat("west"), tileId: 6 as TileId },
        { index: 2, seat: seat("west"), tileId: 7 as TileId },
      ],
    );
    state = openDiscard(state, 4 as TileId).state;
    expect(legalReactionsForSeat(state, seat("south"))).toContainEqual({
      type: "chow",
      handTileIds: [0, 8],
    });
    expect(legalReactionsForSeat(state, seat("west"))).toEqual(
      expect.arrayContaining([
        { type: "pung", handTileIds: [5, 6] },
        { type: "kong", handTileIds: [5, 6, 7] },
      ]),
    );
    expect(legalReactionsForSeat(state, seat("north"))).toEqual([
      { type: "pass" },
    ]);
    expect(
      applyGameCommand(state, state.players.south.actorId, {
        type: "game/react",
        response: {
          type: "chow",
          handTileIds: [8, 0] as [TileId, TileId],
        },
        windowId: state.reactionWindow?.id ?? "missing",
      }),
    ).toMatchObject({ accepted: false, error: { code: "illegal-reaction" } });
  });

  it("resolves arrival permutations identically and gives pung priority over chow", () => {
    const initial = placeInHands(
      startHongKongV1Game(actors, randomness(203)).state,
      [
        { index: 0, seat: seat("east"), tileId: 4 as TileId },
        { index: 0, seat: seat("south"), tileId: 0 as TileId },
        { index: 1, seat: seat("south"), tileId: 8 as TileId },
        { index: 0, seat: seat("west"), tileId: 5 as TileId },
        { index: 1, seat: seat("west"), tileId: 6 as TileId },
      ],
    );
    const opened = openDiscard(initial, 4 as TileId).state;
    const choices: Readonly<Record<string, ReactionResponse>> = {
      south: { type: "chow", handTileIds: [0 as TileId, 8 as TileId] },
      west: { type: "pung", handTileIds: [5 as TileId, 6 as TileId] },
      north: { type: "pass" },
    };
    const orders: readonly (readonly Seat[])[] = [
      [seat("south"), seat("west"), seat("north")],
      [seat("south"), seat("north"), seat("west")],
      [seat("north"), seat("south"), seat("west")],
      [seat("north"), seat("west"), seat("south")],
      [seat("west"), seat("north"), seat("south")],
      [seat("west"), seat("south"), seat("north")],
    ];
    const outcomes = orders.map((order) => {
      let state = opened;
      let resolved: HongKongGameEvent | undefined;
      for (const currentSeat of order) {
        const result = respond(
          state,
          currentSeat,
          choices[currentSeat] ?? { type: "pass" },
        );
        state = result.state;
        resolved =
          result.events.find(
            (event) => event.type === "game/reaction-resolved",
          ) ?? resolved;
      }
      expect(state.turn).toBe("west");
      expect(state.players.west.melds[0]).toMatchObject({
        kind: "pung",
        sourceSeat: "east",
        tileIds: [4, 5, 6],
      });
      return {
        event: resolved === undefined ? "" : canonicalGameEventJson(resolved),
        state: canonicalGameJson(state),
      };
    });
    expect(new Set(outcomes.map(({ state }) => state)).size).toBe(1);
    expect(new Set(outcomes.map(({ event }) => event)).size).toBe(1);
  });

  it("keeps private intention timing out of unauthorized projections", () => {
    let state = placeInHands(
      startHongKongV1Game(actors, randomness(204)).state,
      [
        { index: 0, seat: seat("east"), tileId: 4 as TileId },
        { index: 0, seat: seat("south"), tileId: 0 as TileId },
        { index: 1, seat: seat("south"), tileId: 8 as TileId },
      ],
    );
    state = openDiscard(state, 4 as TileId).state;
    const before = {
      east: projectGame(state, state.players.east.actorId),
      spectator: projectGame(state, "spectator"),
      west: projectGame(state, state.players.west.actorId),
    };
    state = respond(state, seat("south"), {
      type: "chow",
      handTileIds: [0 as TileId, 8 as TileId],
    }).state;
    expect(projectGame(state, state.players.east.actorId)).toEqual(before.east);
    expect(projectGame(state, "spectator")).toEqual(before.spectator);
    expect(projectGame(state, state.players.west.actorId)).toEqual(before.west);
    expect(
      projectGame(state, state.players.south.actorId).viewerActions?.reaction,
    ).toMatchObject({
      actions: [],
      status: "submitted",
    });
    expect(JSON.stringify(projectGame(state, "spectator"))).not.toContain(
      "reaction-intent",
    );
  });

  it("commits concealed and exposed kongs with exact replacement batches", () => {
    const started = startHongKongV1Game(actors, randomness(205));
    let concealed = placeInHands(started.state, [
      { index: 0, seat: seat("east"), tileId: 0 as TileId },
      { index: 1, seat: seat("east"), tileId: 1 as TileId },
      { index: 2, seat: seat("east"), tileId: 2 as TileId },
      { index: 3, seat: seat("east"), tileId: 3 as TileId },
    ]);
    const fixtureGenesis = { ...started.event, state: concealed };
    const declared = applyGameCommand(
      concealed,
      concealed.players.east.actorId,
      {
        type: "game/declare-concealed-kong",
        tileIds: [0, 1, 2, 3] as [TileId, TileId, TileId, TileId],
      },
    );
    expect(declared.accepted).toBe(true);
    if (!declared.accepted || declared.state === undefined) return;
    concealed = declared.state;
    expect(declared.events.map(({ type }) => type)).toEqual([
      "game/concealed-kong-declared",
      "game/kong-replacement-drawn",
    ]);
    expect(concealed.players.east.melds[0]).toMatchObject({
      exposure: "concealed",
      kind: "kong",
      kongKind: "concealed",
      tileIds: [0, 1, 2, 3],
    });
    expect(
      concealed.players.east.hand.length +
        3 * concealed.players.east.melds.length,
    ).toBe(14);
    assertGameInvariants(concealed);
    expect(
      canonicalGameJson(replayGameEvents([fixtureGenesis, ...declared.events])),
    ).toBe(canonicalGameJson(concealed));
    expect(decodeCanonicalGameJson(canonicalGameJson(concealed))).toEqual(
      concealed,
    );
    for (const event of declared.events) {
      expect(
        decodeCanonicalGameEventJson(canonicalGameEventJson(event)),
      ).toEqual(event);
    }

    let exposed = placeInHands(
      startHongKongV1Game(actors, randomness(206)).state,
      [
        { index: 0, seat: seat("east"), tileId: 4 as TileId },
        { index: 0, seat: seat("west"), tileId: 5 as TileId },
        { index: 1, seat: seat("west"), tileId: 6 as TileId },
        { index: 2, seat: seat("west"), tileId: 7 as TileId },
      ],
    );
    exposed = openDiscard(exposed, 4 as TileId).state;
    exposed = respond(exposed, seat("west"), {
      type: "kong",
      handTileIds: [5, 6, 7] as [TileId, TileId, TileId],
    }).state;
    exposed = respond(exposed, seat("south"), { type: "pass" }).state;
    const final = respond(exposed, seat("north"), { type: "pass" });
    exposed = final.state;
    expect(final.events.map(({ type }) => type)).toEqual([
      "game/reaction-intent-submitted",
      "game/reaction-resolved",
      "game/kong-replacement-drawn",
    ]);
    expect(exposed.players.west.melds[0]).toMatchObject({
      exposure: "exposed",
      kind: "kong",
      kongKind: "exposed",
      sourceSeat: "east",
      tileIds: [4, 5, 6, 7],
    });
    assertGameInvariants(exposed);
  });

  it("opens robbing windows and preserves the pung ID when an added kong commits", () => {
    let state = placeInHands(
      startHongKongV1Game(actors, randomness(207)).state,
      [
        { index: 0, seat: seat("east"), tileId: 4 as TileId },
        { index: 0, seat: seat("south"), tileId: 5 as TileId },
        { index: 1, seat: seat("south"), tileId: 6 as TileId },
        { index: 2, seat: seat("south"), tileId: 7 as TileId },
      ],
    );
    state = openDiscard(state, 4 as TileId).state;
    state = respond(state, seat("south"), {
      type: "pung",
      handTileIds: [5, 6] as [TileId, TileId],
    }).state;
    state = respond(state, seat("west"), { type: "pass" }).state;
    state = respond(state, seat("north"), { type: "pass" }).state;
    const meldId = state.players.south.melds[0]?.id;
    if (meldId === undefined) throw new Error("Fixture pung was not created.");
    const proposed = applyGameCommand(state, state.players.south.actorId, {
      type: "game/propose-added-kong",
      meldId,
      tileId: 7 as TileId,
    });
    if (!proposed.accepted || proposed.state === undefined) {
      throw new Error("Added kong proposal failed.");
    }
    state = proposed.state;
    expect(state.phase).toBe("awaiting-added-kong-reactions");
    expect(state.reactionWindow).toMatchObject({
      kind: "added-kong",
      sourceMeldId: meldId,
      sourceTileId: 7,
    });
    expect(
      legalReactionsForSeat(state, seat("west"), {
        includeStructuralWin: true,
      })[0],
    ).toEqual({ type: "pass" });
    state = resolvePasses(state);
    expect(state.players.south.melds[0]).toMatchObject({
      id: meldId,
      kind: "kong",
      kongKind: "added",
      tileIds: [4, 5, 6, 7],
    });
    expect(state.phase).toBe("awaiting-discard");
    assertGameInvariants(state);
  });

  it("models a structurally eligible rob internally without exposing a deployable win", () => {
    const westWinningWait = [
      0, 8, 36, 37, 38, 40, 41, 42, 44, 45, 46, 108, 109,
    ] as const;
    let state = placeInHands(
      startHongKongV1Game(actors, randomness(210)).state,
      [
        { index: 0, seat: seat("east"), tileId: 4 as TileId },
        { index: 0, seat: seat("south"), tileId: 5 as TileId },
        { index: 1, seat: seat("south"), tileId: 6 as TileId },
        { index: 2, seat: seat("south"), tileId: 7 as TileId },
        ...westWinningWait.map((tileId, index) => ({
          index,
          seat: seat("west"),
          tileId: tileId as TileId,
        })),
      ],
    );
    state = openDiscard(state, 4 as TileId).state;
    state = respond(state, seat("south"), {
      type: "pung",
      handTileIds: [5, 6] as [TileId, TileId],
    }).state;
    state = respond(state, seat("west"), { type: "pass" }).state;
    state = respond(state, seat("north"), { type: "pass" }).state;
    const meldId = state.players.south.melds[0]?.id;
    if (meldId === undefined) throw new Error("Fixture pung was not created.");
    const proposed = applyGameCommand(state, state.players.south.actorId, {
      type: "game/propose-added-kong",
      meldId,
      tileId: 7 as TileId,
    });
    if (!proposed.accepted || proposed.state === undefined) {
      throw new Error("Added kong proposal failed.");
    }
    state = proposed.state;
    expect(
      legalReactionsForSeat(state, seat("west"), {
        includeStructuralWin: true,
      }),
    ).toContainEqual({ type: "win", structurallyEligible: true });
    expect(
      projectGame(state, state.players.west.actorId).viewerActions?.reaction
        ?.actions,
    ).not.toContainEqual(expect.objectContaining({ type: "win" }));
    expect(
      applyGameCommand(state, state.players.west.actorId, {
        type: "game/react",
        response: { type: "win" },
        windowId: state.reactionWindow?.id ?? "missing",
      }),
    ).toMatchObject({
      accepted: false,
      error: { code: "win-validation-unavailable" },
    });
    if (state.reactionWindow === null)
      throw new Error("Rob window disappeared.");
    state = reduceGameEvent(state, {
      type: "game/reaction-intent-submitted",
      sequence: state.sequence + 1,
      actorId: state.players.west.actorId,
      response: { type: "win", structurallyEligible: true },
      seat: seat("west"),
      windowId: state.reactionWindow.id,
    }) as CanonicalGameStateV2;
    if (state.reactionWindow === null)
      throw new Error("Rob window disappeared.");
    expect(
      normalizeReactionWindow(state, state.reactionWindow).outcome,
    ).toEqual({ type: "structural-win", seats: ["west"] });
  });

  it("recurses through bonus tiles for a kong replacement", () => {
    let state: CanonicalGameStateV2 | undefined;
    for (let offset = 220; offset < 300; offset += 1) {
      const candidate = startHongKongV1Game(actors, randomness(offset)).state;
      const live = candidate.wall.order.slice(
        candidate.wall.head,
        candidate.wall.tail + 1,
      );
      if (live.filter((id) => Number(id) >= 136).length >= 2) {
        state = candidate;
        break;
      }
    }
    if (state === undefined)
      throw new Error("No live bonus-chain fixture found.");
    state = placeInHands(state, [
      { index: 0, seat: seat("east"), tileId: 0 as TileId },
      { index: 1, seat: seat("east"), tileId: 1 as TileId },
      { index: 2, seat: seat("east"), tileId: 2 as TileId },
      { index: 3, seat: seat("east"), tileId: 3 as TileId },
    ]);
    const order = [...state.wall.order];
    const liveIds = order.slice(state.wall.head, state.wall.tail + 1);
    const bonuses = liveIds.filter((id) => Number(id) >= 136).slice(0, 2);
    const structural = liveIds.find(
      (id) => Number(id) >= 4 && Number(id) < 136,
    );
    if (bonuses.length !== 2 || structural === undefined) {
      throw new Error("Bonus-chain fixture locations disappeared.");
    }
    const desired = [bonuses[0], bonuses[1], structural] as const;
    const targets = [state.wall.tail, state.wall.tail - 1, state.wall.tail - 2];
    for (const [index, target] of targets.entries()) {
      const desiredId = desired[index];
      if (desiredId === undefined)
        throw new Error("Replacement fixture is absent.");
      const source = order.indexOf(desiredId);
      const targetId = order[target];
      if (source < 0 || targetId === undefined)
        throw new Error("Wall fixture is invalid.");
      order[target] = desiredId;
      order[source] = targetId;
    }
    state = { ...state, wall: { ...state.wall, order } };
    assertGameInvariants(state);
    const result = applyGameCommand(state, state.players.east.actorId, {
      type: "game/declare-concealed-kong",
      tileIds: [0, 1, 2, 3] as [TileId, TileId, TileId, TileId],
    });
    if (!result.accepted || result.state === undefined) {
      throw new Error("Bonus-chain kong failed.");
    }
    const replacement = result.events[1];
    expect(replacement).toMatchObject({
      type: "game/kong-replacement-drawn",
      exhausted: false,
      tileIds: desired,
    });
    expect(result.state.players.east.bonuses).toEqual(
      expect.arrayContaining(bonuses),
    );
    assertGameInvariants(result.state);
  });

  it("keeps a committed kong and exhausts when no replacement remains", () => {
    let state = startHongKongV1Game(actors, randomness(208)).state;
    let safety = 0;
    while (state.wall.head <= state.wall.tail && safety < 300) {
      if (state.phase === "awaiting-discard-reactions") {
        state = resolvePasses(state);
      } else if (state.phase === "awaiting-draw") {
        const drawn = applyGameCommand(
          state,
          state.players[state.turn as keyof SeatMap<unknown>].actorId,
          { type: "game/draw" },
        );
        if (!drawn.accepted || drawn.state === undefined)
          throw new Error("Draw failed.");
        state = drawn.state;
      } else {
        const player = state.players[state.turn as keyof SeatMap<unknown>];
        const tileId = player.hand.at(-1);
        if (tileId === undefined)
          throw new Error("Discard fixture has no tile.");
        state = openDiscard(state, tileId).state;
      }
      safety += 1;
    }
    expect(state.phase).toBe("awaiting-discard");
    expect(state.wall.head).toBe(state.wall.tail + 1);
    const turn = state.turn;
    state = placeInHands(state, [
      { index: 0, seat: turn, tileId: 0 as TileId },
      { index: 1, seat: turn, tileId: 1 as TileId },
      { index: 2, seat: turn, tileId: 2 as TileId },
      { index: 3, seat: turn, tileId: 3 as TileId },
    ]);
    const result = applyGameCommand(
      state,
      state.players[turn as keyof SeatMap<unknown>].actorId,
      {
        type: "game/declare-concealed-kong",
        tileIds: [0, 1, 2, 3] as [TileId, TileId, TileId, TileId],
      },
    );
    if (!result.accepted || result.state === undefined) {
      throw new Error("Exhausting kong declaration failed.");
    }
    expect(result.state.phase).toBe("exhausted");
    expect(
      result.state.players[turn as keyof SeatMap<unknown>].melds,
    ).toHaveLength(1);
    assertGameInvariants(result.state);
  });

  it("rejects forged normalized resolution and event fields", () => {
    let state = startHongKongV1Game(actors, randomness(209)).state;
    const tileId = state.players.east.hand[0];
    if (tileId === undefined) throw new Error("Dealer has no tile.");
    state = openDiscard(state, tileId).state;
    const resolution = decideReactionExpiration(state);
    if (!resolution.accepted) throw new Error("Resolution fixture failed.");
    const event = resolution.events[0];
    if (event.type !== "game/reaction-resolved") {
      throw new Error("Resolution fixture returned the wrong event.");
    }
    expect(() =>
      reduceGameEvent(state, {
        ...event,
        responses: event.responses.slice(1),
      }),
    ).toThrow(/reaction resolution/iu);
    expect(() =>
      decodeCanonicalGameEventJson(
        canonicalGameEventJson(event).replace(/}$/, ',"forged":true}'),
      ),
    ).toThrow("unknown or missing");
  });
});
