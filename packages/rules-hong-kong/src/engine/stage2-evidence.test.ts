import { seat, seats, type Seat, type TileId } from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import { legalReactionsForSeat } from "../claims/legal-reactions.js";
import type {
  CanonicalGameStateV1,
  CanonicalGameStateV2,
  ReactionResponse,
  SeatMap,
} from "./game-state.js";
import {
  applyGameCommand,
  applyGameCommandV2,
  assertGameInvariants,
  canonicalEventHashPayload,
  canonicalGameEventJson,
  canonicalVersionedGameJson as canonicalGameJson,
  canonicalVersionedGameEventJson,
  createStateUpgradeEvent,
  decodeCanonicalGameEventJson,
  decodeCanonicalVersionedGameEventJson,
  decideReactionExpiration,
  projectGame,
  projectGameV2,
  projectLegacyCompatibleGameV2,
  reduceVersionedGameEvent,
  replayGameEvents,
  replayVersionedGameEvents,
  startHongKongV1Game,
  startHongKongV2Game,
  upgradeCanonicalGameState,
  type HongKongGameEvent,
  type VersionedHongKongGameEvent,
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

function playerAt<Value>(players: SeatMap<Value>, currentSeat: Seat): Value {
  return players[currentSeat as keyof SeatMap<Value>];
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
        const player = playerAt(state.players, currentSeat);
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
    const current = playerAt(next.players, placement.seat).hand[
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
  readonly events: readonly VersionedHongKongGameEvent[];
  readonly state: CanonicalGameStateV2;
} {
  const result = applyGameCommandV2(
    state,
    playerAt(state.players, state.turn).actorId,
    { type: "game/discard", tileId },
  );
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
  readonly events: readonly VersionedHongKongGameEvent[];
  readonly state: CanonicalGameStateV2;
} {
  if (state.reactionWindow === null) throw new Error("No fixture window.");
  const publicResponse =
    response.type === "win" ? ({ type: "win" } as const) : response;
  const result = applyGameCommandV2(
    state,
    playerAt(state.players, responder).actorId,
    {
      type: "game/react",
      response: publicResponse,
      windowId: state.reactionWindow.id,
    },
  );
  if (!result.accepted || result.state === undefined) {
    throw new Error(`Fixture response was rejected: ${response.type}.`);
  }
  return { events: result.events, state: result.state };
}

function resolvePasses(state: CanonicalGameStateV2): CanonicalGameStateV2 {
  const decision = decideReactionExpiration(state);
  if (!decision.accepted) throw new Error("Fixture expiry was rejected.");
  let next = state;
  for (const event of decision.events) {
    const reduced = reduceVersionedGameEvent(next, event);
    if (reduced.schemaVersion !== 2) throw new Error("V2 reduced to v1.");
    next = reduced;
  }
  return next;
}

const responseOrders: readonly (readonly Seat[])[] = [
  [seat("south"), seat("west"), seat("north")],
  [seat("south"), seat("north"), seat("west")],
  [seat("west"), seat("south"), seat("north")],
  [seat("west"), seat("north"), seat("south")],
  [seat("north"), seat("south"), seat("west")],
  [seat("north"), seat("west"), seat("south")],
];

function permutationResults(
  opened: CanonicalGameStateV2,
  choices: Readonly<Record<string, ReactionResponse>>,
): readonly string[] {
  return responseOrders.map((order) => {
    let state = opened;
    const emitted: VersionedHongKongGameEvent[] = [];
    for (const currentSeat of order) {
      const result = respond(
        state,
        currentSeat,
        choices[currentSeat] ?? { type: "pass" },
      );
      for (const event of result.events) expectVersionedRoundTrip(event);
      emitted.push(...result.events);
      state = result.state;
    }
    return JSON.stringify({
      resolution: emitted
        .filter((event) => event.type !== "game/reaction-intent-submitted")
        .map(canonicalVersionedGameEventJson),
      state: canonicalGameJson(state),
    });
  });
}

function arrangeNextLegacyDraw(
  state: CanonicalGameStateV1,
  replacement: boolean,
): CanonicalGameStateV1 {
  const order = [...state.wall.order];
  const live = order.slice(state.wall.head, state.wall.tail + 1);
  const bonus = live.find((id) => Number(id) >= 136);
  const structural = live.find((id) => Number(id) < 136);
  if (bonus === undefined || structural === undefined) {
    throw new Error("Legacy draw fixture lacks live tile kinds.");
  }
  const put = (index: number, desired: TileId): void => {
    const source = order.indexOf(desired);
    const displaced = order[index];
    if (source < 0 || displaced === undefined)
      throw new Error("Bad wall fixture.");
    order[index] = desired;
    order[source] = displaced;
  };
  if (replacement) {
    put(state.wall.head, bonus);
    put(state.wall.tail, structural);
  } else {
    put(state.wall.head, structural);
  }
  const arranged = { ...state, wall: { ...state.wall, order } };
  assertGameInvariants(arranged);
  return arranged;
}

function legacyDrawHistory(
  replacement: boolean,
): readonly [HongKongGameEvent, ...HongKongGameEvent[]] {
  const started = startHongKongV1Game(
    actors,
    randomness(replacement ? 302 : 301),
  );
  const genesisState = arrangeNextLegacyDraw(started.state, replacement);
  const genesis = { ...started.event, state: genesisState };
  const openingTile = genesisState.players.east.hand[0];
  if (openingTile === undefined) throw new Error("East has no opening tile.");
  const discarded = applyGameCommand(
    genesisState,
    genesisState.players.east.actorId,
    { type: "game/discard", tileId: openingTile },
  );
  if (!discarded.accepted || discarded.state === undefined) {
    throw new Error("Legacy discard failed.");
  }
  const drawn = applyGameCommand(
    discarded.state,
    discarded.state.players.south.actorId,
    { type: "game/draw" },
  );
  if (!drawn.accepted || drawn.state === undefined) {
    throw new Error("Legacy draw failed.");
  }
  return [genesis, discarded.event, drawn.event];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function expectVersionedRoundTrip(event: VersionedHongKongGameEvent): void {
  const bytes = canonicalVersionedGameEventJson(event);
  expect(decodeCanonicalVersionedGameEventJson(bytes)).toEqual(event);
}

describe("stage 2 compatibility and invariant evidence", () => {
  it("keeps legacy persistence single-event and v2 persistence batch-only", () => {
    const legacy = startHongKongV1Game(actors, randomness(299)).state;
    const legacyTile = legacy.players.east.hand[0];
    if (legacyTile === undefined) throw new Error("East has no legacy tile.");
    const legacyResult = applyGameCommand(legacy, legacy.players.east.actorId, {
      type: "game/discard",
      tileId: legacyTile,
    });
    expect(legacyResult).toHaveProperty("event");
    expect(legacyResult).not.toHaveProperty("events");

    let v2 = startHongKongV2Game(actors, randomness(300)).state;
    v2 = placeInHands(v2, [
      { index: 0, seat: seat("east"), tileId: 0 as TileId },
      { index: 1, seat: seat("east"), tileId: 1 as TileId },
      { index: 2, seat: seat("east"), tileId: 2 as TileId },
      { index: 3, seat: seat("east"), tileId: 3 as TileId },
    ]);
    const v2Result = applyGameCommandV2(v2, v2.players.east.actorId, {
      type: "game/declare-concealed-kong",
      tileIds: [0, 1, 2, 3] as [TileId, TileId, TileId, TileId],
    });
    expect(v2Result).toHaveProperty("events");
    expect(v2Result).not.toHaveProperty("event");
    if (!v2Result.accepted) throw new Error("V2 kong was rejected.");
    expect(v2Result.events).toHaveLength(2);
    expect(v2Result.state?.sequence).toBe(v2.sequence + 2);
  });

  it("pins historical schema-v1 event bytes and their hash payload", async () => {
    const started = startHongKongV1Game(actors, randomness(307));
    const bytes = canonicalGameEventJson(started.event);
    expect(decodeCanonicalGameEventJson(bytes)).toEqual(started.event);
    expectVersionedRoundTrip(started.event);
    expect(await sha256Hex(bytes)).toBe(
      "4e5676d5752d22d01643af218f9f41d1948c9148a433294464277118e88701d0",
    );
    expect(
      await sha256Hex(canonicalEventHashPayload(null, started.event)),
    ).toBe("9741277eb501089a441bc4fa770d1fa98440ebefdba001a7202203cef2e4b2c4");
  });

  it("retains the strict historical exhausted-state hand-size invariant", () => {
    const started = startHongKongV1Game(actors, randomness(308));
    let state = started.state;
    const events: HongKongGameEvent[] = [started.event];
    let turns = 0;
    while (state.phase !== "exhausted" && turns < 300) {
      const player = playerAt(state.players, state.turn);
      const discardTileId = player.hand.at(-1);
      if (discardTileId === undefined) {
        throw new Error("Legacy exhaustion fixture has an empty hand.");
      }
      const command =
        state.phase === "awaiting-draw"
          ? ({ type: "game/draw" } as const)
          : ({
              type: "game/discard",
              tileId: discardTileId,
            } as const);
      const result = applyGameCommand(state, player.actorId, command);
      if (!result.accepted || result.state === undefined) {
        throw new Error("Legacy exhaustion fixture failed.");
      }
      state = result.state;
      events.push(result.event);
      turns += 1;
    }
    expect(state.phase).toBe("exhausted");
    expect(events.at(-1)?.type).toBe("game/wall-exhausted");
    for (const event of events) expectVersionedRoundTrip(event);
    expect(
      seats.map(
        (currentSeat) => playerAt(state.players, currentSeat).hand.length,
      ),
    ).toEqual([13, 13, 13, 13]);
    const moved = state.players.south.hand[0];
    if (moved === undefined) throw new Error("South has no tile to move.");
    const forged: CanonicalGameStateV1 = {
      ...state,
      players: {
        ...state.players,
        east: {
          ...state.players.east,
          hand: [...state.players.east.hand, moved],
        },
        south: {
          ...state.players.south,
          hand: state.players.south.hand.slice(1),
        },
      },
    };
    expect(() => {
      assertGameInvariants(forged);
    }).toThrow(/13(?:-tile| structural)/iu);
  });

  it.each([
    ["ordinary draw", false, "draw"],
    ["bonus replacement", true, "replacement"],
  ] as const)(
    "derives exact upgrade provenance from an awaiting-discard %s",
    (_name, replacement, acquisition) => {
      const history = legacyDrawHistory(replacement);
      const legacy = replayGameEvents(history);
      const last = history.at(-1);
      if (last?.type !== "game/turn-drawn")
        throw new Error("Expected legacy draw.");
      const event = createStateUpgradeEvent(history);
      expectVersionedRoundTrip(event);
      expect(event).toMatchObject({
        fromSchemaVersion: 1,
        provenance: {
          eastHasDiscarded: true,
          exhausted: false,
          ordinaryTileId: last.ordinaryTileId,
          replacementTileIds: last.replacementTileIds,
          seat: "south",
          sourceSequence: last.sequence,
          type: "draw",
        },
        sequence: legacy.sequence + 1,
        toSchemaVersion: 2,
        type: "game/state-upgraded",
      });
      const upgraded = upgradeCanonicalGameState(history);
      expect(upgraded.state.turnProvenance).toMatchObject({
        eastHasDeclaredKong: false,
        eastHasDiscarded: true,
        lastAcquiredTileId:
          last.replacementTileIds.at(-1) ?? last.ordinaryTileId,
        lastAcquisition: acquisition,
        replacementChainDepth: 0,
        replacementPending: false,
      });
      expect(
        canonicalGameJson(
          replayVersionedGameEvents([...history, upgraded.event]),
        ),
      ).toBe(canonicalGameJson(upgraded.state));
    },
  );

  it("rejects upgrade provenance that disagrees with verified legacy history", () => {
    const history = legacyDrawHistory(false);
    const legacy = replayGameEvents(history);
    const event = createStateUpgradeEvent(history);
    expect(() =>
      reduceVersionedGameEvent(legacy, {
        ...event,
        provenance: { ...event.provenance, sourceSequence: 1 },
      }),
    ).toThrow(/provenance/iu);
    expect(() =>
      reduceVersionedGameEvent(legacy, {
        ...event,
        provenance: { ...event.provenance, eastHasDiscarded: false },
      }),
    ).toThrow(/provenance/iu);
  });

  it("keeps player and spectator legacy projection bytes unchanged across upgrade", () => {
    const history = legacyDrawHistory(true);
    const legacy = replayGameEvents(history);
    const upgraded = upgradeCanonicalGameState(history).state;
    for (const viewer of [legacy.players.south.actorId, "spectator"]) {
      expect(
        JSON.stringify(projectLegacyCompatibleGameV2(upgraded, viewer)),
      ).toBe(JSON.stringify(projectGame(legacy, viewer)));
    }
  });

  it("rejects semantically impossible v2 turn provenance", () => {
    const started = startHongKongV2Game(actors, randomness(309)).state;
    const opponentTile = started.players.south.hand[0];
    if (opponentTile === undefined) throw new Error("South has no tile.");
    const openingTile = started.players.east.hand[0];
    if (openingTile === undefined) throw new Error("East has no tile.");
    const awaitingDraw = resolvePasses(openDiscard(started, openingTile).state);
    const forged: readonly CanonicalGameStateV2[] = [
      {
        ...started,
        turnProvenance: {
          ...started.turnProvenance,
          lastAcquiredTileId: opponentTile,
        },
      },
      {
        ...started,
        turnProvenance: { ...started.turnProvenance, lastAcquiredTileId: null },
      },
      {
        ...started,
        turnProvenance: { ...started.turnProvenance, lastAcquisition: null },
      },
      {
        ...started,
        turnProvenance: {
          ...started.turnProvenance,
          lastAcquiredTileId: null,
          lastAcquisition: null,
        },
      },
      {
        ...started,
        turnProvenance: { ...started.turnProvenance, replacementChainDepth: 2 },
      },
      {
        ...awaitingDraw,
        turnProvenance: {
          ...awaitingDraw.turnProvenance,
          replacementPending: true,
        },
      },
    ];
    expect(
      forged.map((candidate) => {
        try {
          assertGameInvariants(candidate);
          return false;
        } catch {
          return true;
        }
      }),
    ).toEqual([true, true, true, true, true, true]);

    const kongReady = placeInHands(
      startHongKongV2Game(actors, randomness(310)).state,
      [0, 1, 2, 3].map((tileId, index) => ({
        index,
        seat: seat("east"),
        tileId: tileId as TileId,
      })),
    );
    const replaced = applyGameCommandV2(
      kongReady,
      kongReady.players.east.actorId,
      {
        type: "game/declare-concealed-kong",
        tileIds: [0, 1, 2, 3] as [TileId, TileId, TileId, TileId],
      },
    );
    if (!replaced.accepted || replaced.state === undefined) {
      throw new Error("Replacement provenance fixture failed.");
    }
    const replacementState = replaced.state;
    expect(replacementState.turnProvenance).toMatchObject({
      lastAcquisition: "replacement",
      replacementChainDepth: 1,
      replacementPending: false,
    });
    assertGameInvariants(replacementState);
    expect(() => {
      assertGameInvariants({
        ...replacementState,
        turnProvenance: {
          ...replacementState.turnProvenance,
          replacementChainDepth: 2,
        },
      });
    }).toThrow(/provenance/iu);
  });
});

describe("stage 2 claims, kong, and replay evidence", () => {
  it.each([
    ["all pass", {}, "south", 0],
    [
      "chow only",
      {
        south: {
          type: "chow",
          handTileIds: [0 as TileId, 8 as TileId],
        },
      },
      "south",
      1,
    ],
    [
      "exposed kong",
      {
        west: {
          type: "kong",
          handTileIds: [5 as TileId, 6 as TileId, 7 as TileId],
        },
      },
      "west",
      1,
    ],
  ] as const)(
    "normalizes every %s arrival permutation",
    (_name, choices, expectedTurn, meldCount) => {
      let state = placeInHands(
        startHongKongV2Game(actors, randomness(320)).state,
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
      const results = permutationResults(state, choices);
      expect(new Set(results).size).toBe(1);
      const example = responseOrders[0];
      if (example === undefined) throw new Error("No response order fixture.");
      let resolved = state;
      for (const responderSeat of example) {
        resolved = respond(
          resolved,
          responderSeat,
          (choices as Readonly<Record<string, ReactionResponse>>)[
            responderSeat
          ] ?? { type: "pass" },
        ).state;
      }
      expect(resolved.turn).toBe(expectedTurn);
      expect(playerAt(resolved.players, seat(expectedTurn)).melds).toHaveLength(
        meldCount,
      );
      assertGameInvariants(resolved);
    },
  );

  it("commits an East exposed kong with replacement, replay, and conservation", () => {
    const started = startHongKongV2Game(actors, randomness(319));
    let state = placeInHands(started.state, [
      { index: 0, seat: seat("east"), tileId: 5 as TileId },
      { index: 1, seat: seat("east"), tileId: 6 as TileId },
      { index: 2, seat: seat("east"), tileId: 7 as TileId },
      { index: 0, seat: seat("south"), tileId: 4 as TileId },
    ]);
    const genesis: VersionedHongKongGameEvent = {
      ...started.event,
      state,
    };
    const events: VersionedHongKongGameEvent[] = [genesis];
    const eastDiscard = state.players.east.hand.find(
      (tileId) => ![5, 6, 7].includes(Number(tileId)),
    );
    if (eastDiscard === undefined) throw new Error("East has no spare tile.");
    const firstOpened = openDiscard(state, eastDiscard);
    events.push(...firstOpened.events);
    state = firstOpened.state;
    for (const responderSeat of [seat("south"), seat("west"), seat("north")]) {
      const passed = respond(state, responderSeat, { type: "pass" });
      events.push(...passed.events);
      state = passed.state;
    }
    const drawn = applyGameCommandV2(state, state.players.south.actorId, {
      type: "game/draw",
    });
    if (!drawn.accepted || drawn.state === undefined) {
      throw new Error("South draw failed.");
    }
    events.push(...drawn.events);
    state = drawn.state;
    const secondOpened = openDiscard(state, 4 as TileId);
    events.push(...secondOpened.events);
    state = secondOpened.state;
    for (const [responderSeat, response] of [
      [seat("west"), { type: "pass" }],
      [seat("north"), { type: "pass" }],
      [
        seat("east"),
        {
          type: "kong",
          handTileIds: [5, 6, 7] as [TileId, TileId, TileId],
        },
      ],
    ] as const) {
      const reacted = respond(state, responderSeat, response);
      events.push(...reacted.events);
      state = reacted.state;
    }
    expect(state.turn).toBe("east");
    expect(state.players.east.melds).toContainEqual(
      expect.objectContaining({
        claimedTileId: 4,
        kind: "kong",
        kongKind: "exposed",
        sourceSeat: "south",
        tileIds: [4, 5, 6, 7],
      }),
    );
    expect(state.turnProvenance).toMatchObject({
      eastHasDeclaredKong: true,
      lastAcquisition: "replacement",
      replacementChainDepth: 1,
      replacementPending: false,
    });
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      "game/reaction-intent-submitted",
      "game/reaction-resolved",
      "game/kong-replacement-drawn",
    ]);
    assertGameInvariants(state);
    expect(canonicalGameJson(replayVersionedGameEvents(events))).toBe(
      canonicalGameJson(state),
    );
  });

  it("rejects an invalid physical-ID matrix without consuming a response", () => {
    let state = placeInHands(
      startHongKongV2Game(actors, randomness(321)).state,
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
    if (state.reactionWindow === null) throw new Error("No reaction window.");
    const invalid: readonly {
      readonly response: Exclude<ReactionResponse, { readonly type: "win" }>;
      readonly seat: Seat;
    }[] = [
      {
        seat: seat("south"),
        response: { type: "chow", handTileIds: [8, 0] as [TileId, TileId] },
      },
      {
        seat: seat("south"),
        response: { type: "chow", handTileIds: [0, 0] as [TileId, TileId] },
      },
      {
        seat: seat("south"),
        response: { type: "chow", handTileIds: [1, 8] as [TileId, TileId] },
      },
      {
        seat: seat("west"),
        response: { type: "pung", handTileIds: [6, 5] as [TileId, TileId] },
      },
      {
        seat: seat("west"),
        response: { type: "pung", handTileIds: [5, 5] as [TileId, TileId] },
      },
      {
        seat: seat("west"),
        response: {
          type: "kong",
          handTileIds: [5, 6, 99] as [TileId, TileId, TileId],
        },
      },
      {
        seat: seat("north"),
        response: { type: "chow", handTileIds: [0, 8] as [TileId, TileId] },
      },
    ];
    for (const fixture of invalid) {
      const result = applyGameCommandV2(
        state,
        playerAt(state.players, fixture.seat).actorId,
        {
          type: "game/react",
          response: fixture.response,
          windowId: state.reactionWindow.id,
        },
      );
      expect(result).toMatchObject({ accepted: false });
      expect(state.reactionWindow.intents).toEqual({});
    }
  });

  it("rejects duplicate, unsorted, mixed-kind, and absent concealed-kong IDs", () => {
    const state = placeInHands(
      startHongKongV2Game(actors, randomness(325)).state,
      [0, 1, 2, 3].map((tileId, index) => ({
        index,
        seat: seat("east"),
        tileId: tileId as TileId,
      })),
    );
    const invalid = [
      [1, 0, 2, 3],
      [0, 1, 2, 2],
      [0, 1, 2, 4],
      [0, 1, 2, 99],
    ] as const;
    for (const tileIds of invalid) {
      expect(
        applyGameCommandV2(state, state.players.east.actorId, {
          type: "game/declare-concealed-kong",
          tileIds: tileIds as readonly [TileId, TileId, TileId, TileId],
        }),
      ).toMatchObject({ accepted: false });
    }
  });

  it("supports chained concealed kongs and preserves all physical tiles", () => {
    let state = placeInHands(
      startHongKongV2Game(actors, randomness(322)).state,
      [0, 1, 2, 3, 4, 5, 6, 7].map((tileId, index) => ({
        index,
        seat: seat("east"),
        tileId: tileId as TileId,
      })),
    );
    const events: VersionedHongKongGameEvent[] = [];
    for (const tileIds of [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ] as const) {
      const result = applyGameCommandV2(state, state.players.east.actorId, {
        type: "game/declare-concealed-kong",
        tileIds: tileIds as readonly [TileId, TileId, TileId, TileId],
      });
      if (!result.accepted || result.state === undefined) {
        throw new Error("Chained kong fixture was rejected.");
      }
      for (const event of result.events) expectVersionedRoundTrip(event);
      events.push(...result.events);
      state = result.state;
      assertGameInvariants(state);
    }
    expect(state.players.east.melds).toHaveLength(2);
    expect(state.turnProvenance).toMatchObject({
      lastAcquisition: "replacement",
      replacementChainDepth: 2,
      replacementPending: false,
    });
    expect(events.map((event) => event.type)).toEqual([
      "game/concealed-kong-declared",
      "game/kong-replacement-drawn",
      "game/concealed-kong-declared",
      "game/kong-replacement-drawn",
    ]);
  });

  it("freezes a provisional robbed-added-kong outcome pending validation", () => {
    const westWinningWait = [
      0, 8, 36, 37, 38, 40, 41, 42, 44, 45, 46, 108, 109,
    ] as const;
    let state = placeInHands(
      startHongKongV2Game(actors, randomness(324)).state,
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
    const pung = state.players.south.melds[0];
    if (pung === undefined) throw new Error("Rob fixture has no pung.");
    expect(
      applyGameCommandV2(state, state.players.south.actorId, {
        type: "game/propose-added-kong",
        meldId: "meld:forged",
        tileId: 7 as TileId,
      }),
    ).toMatchObject({ accepted: false });
    expect(
      applyGameCommandV2(state, state.players.south.actorId, {
        type: "game/propose-added-kong",
        meldId: pung.id,
        tileId: 99 as TileId,
      }),
    ).toMatchObject({ accepted: false });
    const proposal = applyGameCommandV2(state, state.players.south.actorId, {
      type: "game/propose-added-kong",
      meldId: pung.id,
      tileId: 7 as TileId,
    });
    if (!proposal.accepted || proposal.state === undefined) {
      throw new Error("Added-kong proposal was rejected.");
    }
    for (const event of proposal.events) expectVersionedRoundTrip(event);
    state = proposal.state;
    const window = state.reactionWindow;
    if (window?.kind !== "added-kong") throw new Error("No robbing window.");
    const intent = {
      actorId: state.players.west.actorId,
      response: { type: "win", structurallyEligible: true },
      seat: seat("west"),
      sequence: state.sequence + 1,
      type: "game/reaction-intent-submitted",
      windowId: window.id,
    } as const;
    expectVersionedRoundTrip(intent);
    const withIntent = reduceVersionedGameEvent(state, intent);
    if (withIntent.schemaVersion !== 2)
      throw new Error("Rob intent reduced to v1.");
    const resolution = decideReactionExpiration(withIntent);
    if (!resolution.accepted) throw new Error("Rob resolution was rejected.");
    const event = resolution.events[0];
    if (event.type !== "game/reaction-resolved") {
      throw new Error("Rob resolution emitted the wrong event.");
    }
    expect(event).toMatchObject({
      outcome: { seats: ["west"], type: "structural-win" },
      type: "game/reaction-resolved",
      windowId: window.id,
    });
    expectVersionedRoundTrip(event);
    const reduced = reduceVersionedGameEvent(withIntent, event);
    if (reduced.schemaVersion !== 2)
      throw new Error("Rob result reduced to v1.");
    expect(reduced.sequence).toBe(event.sequence);
    expect(reduced.phase).toBe("pending-win-validation");
    expect(reduced.reactionWindow).toEqual(withIntent.reactionWindow);
    expect(reduced.players.south.melds[0]).toEqual(pung);
    expect(reduced.players.south.hand).toContain(7);
    expect(reduced.players.west.hand).not.toContain(7);
    const frozenView = projectGameV2(reduced, reduced.players.west.actorId);
    expect(frozenView.reaction).toBeUndefined();
    expect(frozenView.viewerActions?.reaction).toBeUndefined();
    expect(decideReactionExpiration(reduced)).toMatchObject({
      accepted: false,
      error: { code: "no-reaction-window" },
    });
    expect(
      applyGameCommandV2(reduced, reduced.players.north.actorId, {
        type: "game/react",
        response: { type: "pass" },
        windowId: window.id,
      }),
    ).toMatchObject({ accepted: false });
    expect(() =>
      reduceVersionedGameEvent(reduced, {
        ...event,
        sequence: reduced.sequence + 1,
      }),
    ).toThrow(/closed window/iu);
    expect(() =>
      reduceVersionedGameEvent(reduced, {
        actorId: reduced.players.north.actorId,
        response: { type: "pass" },
        seat: seat("north"),
        sequence: reduced.sequence + 1,
        type: "game/reaction-intent-submitted",
        windowId: window.id,
      }),
    ).toThrow(/not valid/iu);
    assertGameInvariants(reduced);
    expect(
      decodeCanonicalVersionedGameEventJson(
        canonicalVersionedGameEventJson(event),
      ),
    ).toEqual(event);
  });

  it("round-trips every emitted event and rejects forged reducer transitions", () => {
    let state = placeInHands(
      startHongKongV2Game(actors, randomness(323)).state,
      [
        { index: 0, seat: seat("east"), tileId: 4 as TileId },
        { index: 0, seat: seat("west"), tileId: 5 as TileId },
        { index: 1, seat: seat("west"), tileId: 6 as TileId },
        { index: 2, seat: seat("west"), tileId: 7 as TileId },
      ],
    );
    const genesis = {
      ...startHongKongV2Game(actors, randomness(323)).event,
      state,
    };
    const opened = openDiscard(state, 4 as TileId);
    const reactionState = opened.state;
    const allEvents: VersionedHongKongGameEvent[] = [genesis, ...opened.events];
    state = opened.state;
    const order = responseOrders[0];
    if (order === undefined) throw new Error("No response order fixture.");
    for (const responderSeat of order) {
      const action =
        responderSeat === seat("west")
          ? ({
              type: "kong",
              handTileIds: [5, 6, 7] as [TileId, TileId, TileId],
            } as const)
          : ({ type: "pass" } as const);
      const result = respond(state, responderSeat, action);
      allEvents.push(...result.events);
      state = result.state;
    }
    for (const event of allEvents) {
      const bytes = canonicalVersionedGameEventJson(event);
      expect(decodeCanonicalVersionedGameEventJson(bytes)).toEqual(event);
    }
    expect(canonicalGameJson(replayVersionedGameEvents(allEvents))).toBe(
      canonicalGameJson(state),
    );
    const openedEvent = opened.events[0];
    if (openedEvent?.type !== "game/discard-reaction-opened") {
      throw new Error("Expected discard-open event.");
    }
    expect(() =>
      reduceVersionedGameEvent(
        placeInHands(startHongKongV2Game(actors, randomness(323)).state, [
          { index: 0, seat: seat("east"), tileId: 4 as TileId },
          { index: 0, seat: seat("west"), tileId: 5 as TileId },
          { index: 1, seat: seat("west"), tileId: 6 as TileId },
          { index: 2, seat: seat("west"), tileId: 7 as TileId },
        ]),
        { ...openedEvent, tileId: 99 as TileId },
      ),
    ).toThrow();
    if (reactionState.reactionWindow === null) {
      throw new Error("Expected reaction window.");
    }
    const reactionWindow = reactionState.reactionWindow;
    expect(() =>
      reduceVersionedGameEvent(reactionState, {
        actorId: reactionState.players.east.actorId,
        response: { type: "pass" },
        seat: seat("south"),
        sequence: reactionState.sequence + 1,
        type: "game/reaction-intent-submitted",
        windowId: reactionWindow.id,
      }),
    ).toThrow();
    const expiration = decideReactionExpiration(reactionState);
    if (!expiration.accepted) throw new Error("Expiration fixture failed.");
    const resolution = expiration.events[0];
    if (resolution.type !== "game/reaction-resolved") {
      throw new Error("Expected reaction resolution.");
    }
    expect(() =>
      reduceVersionedGameEvent(reactionState, {
        ...resolution,
        responses: resolution.responses.slice(1),
      }),
    ).toThrow();
    const replacementIndex = allEvents.findIndex(
      (event) => event.type === "game/kong-replacement-drawn",
    );
    const replacement = allEvents[replacementIndex];
    if (
      replacementIndex < 0 ||
      replacement?.type !== "game/kong-replacement-drawn"
    ) {
      throw new Error("Expected kong replacement.");
    }
    const pending = replayVersionedGameEvents(
      allEvents.slice(0, replacementIndex),
    );
    if (pending.schemaVersion !== 2) throw new Error("Pending kong is legacy.");
    expect(() =>
      reduceVersionedGameEvent(pending, {
        ...replacement,
        tileIds: [99 as TileId],
      }),
    ).toThrow();
  });

  it("runs seeded legal claim/kong simulations with invariant and replay checks", () => {
    let observedClaims = 0;
    let observedKongs = 0;
    for (const seed of [331, 337, 349, 353]) {
      const started = startHongKongV2Game(actors, randomness(seed));
      let state = placeInHands(
        started.state,
        [0, 1, 2, 3].map((tileId, index) => ({
          index,
          seat: seat("east"),
          tileId: tileId as TileId,
        })),
      );
      const events: VersionedHongKongGameEvent[] = [
        { ...started.event, state },
      ];
      let cursor = seed >>> 0;
      const choose = <Value>(values: readonly Value[]): Value => {
        cursor = (Math.imul(cursor, 1_664_525) + 1_013_904_223) >>> 0;
        const value = values[cursor % values.length];
        if (value === undefined) throw new Error("Seeded choice was empty.");
        return value;
      };
      let steps = 0;
      while (state.phase !== "exhausted" && steps < 500) {
        let batch: readonly VersionedHongKongGameEvent[];
        let next: CanonicalGameStateV2;
        if (state.reactionWindow !== null) {
          const outstanding = state.reactionWindow.responderOrder.filter(
            (currentSeat) =>
              !Object.hasOwn(
                state.reactionWindow?.intents ?? {},
                playerAt(state.players, currentSeat).actorId,
              ),
          );
          const responderSeat = outstanding[0];
          if (responderSeat === undefined) throw new Error("No responder.");
          const legal = legalReactionsForSeat(state, responderSeat).filter(
            (action) => action.type !== "win",
          );
          const claims = legal.filter((action) => action.type !== "pass");
          const action =
            claims.length > 0 ? choose(claims) : ({ type: "pass" } as const);
          const result = respond(state, responderSeat, action);
          batch = result.events;
          next = result.state;
        } else if (state.phase === "awaiting-draw") {
          const actorId = playerAt(state.players, state.turn).actorId;
          const result = applyGameCommandV2(state, actorId, {
            type: "game/draw",
          });
          if (!result.accepted || result.state === undefined)
            throw new Error("Seeded draw failed.");
          batch = result.events;
          next = result.state;
        } else {
          const player = playerAt(state.players, state.turn);
          const selfView = projectGameV2(state, player.actorId);
          const selfActions = selfView.viewerActions?.self ?? [];
          const kong = selfActions.find(
            (action) =>
              action.type === "game/declare-concealed-kong" ||
              action.type === "game/propose-added-kong",
          );
          const discards = selfActions.filter(
            (action) => action.type === "game/discard",
          );
          const action = kong ?? choose(discards);
          const result = applyGameCommandV2(state, player.actorId, action);
          if (!result.accepted || result.state === undefined)
            throw new Error("Seeded self action failed.");
          batch = result.events;
          next = result.state;
        }
        for (const event of batch) {
          if (
            event.type === "game/reaction-resolved" &&
            event.outcome.type === "claim"
          )
            observedClaims += 1;
          if (
            event.type === "game/concealed-kong-declared" ||
            (event.type === "game/reaction-resolved" &&
              event.outcome.type === "claim" &&
              event.outcome.response.type === "kong")
          )
            observedKongs += 1;
          events.push(event);
        }
        state = next;
        assertGameInvariants(state);
        steps += 1;
      }
      expect(state.phase).toBe("exhausted");
      expect(canonicalGameJson(replayVersionedGameEvents(events))).toBe(
        canonicalGameJson(state),
      );
    }
    expect(observedClaims).toBeGreaterThan(0);
    expect(observedKongs).toBeGreaterThan(0);
  });
});
