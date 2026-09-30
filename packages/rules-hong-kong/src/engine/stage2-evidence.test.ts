import { seat, seats, type Seat, type TileId } from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import { legalReactionsForSeat } from "../claims/legal-reactions.js";
import type {
  CanonicalGameStateV1,
  ReactionResponse,
  SeatMap,
} from "./game-state.js";
import {
  applyGameCommandV1,
  assertGameInvariants,
  canonicalGameEventJson,
  canonicalGameJson,
  decodeCanonicalGameEventJson,
  decideReactionExpiration,
  projectGameV1,
  reduceGameEvent,
  replayGameEvents,
  startHongKongV1Game,
  type HongKongGameEventV1,
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
  state: CanonicalGameStateV1,
  left: TileId,
  right: TileId,
): CanonicalGameStateV1 {
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
    ) as unknown as CanonicalGameStateV1["players"],
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
  state: CanonicalGameStateV1,
  placements: readonly {
    readonly index: number;
    readonly seat: Seat;
    readonly tileId: TileId;
  }[],
): CanonicalGameStateV1 {
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
  state: CanonicalGameStateV1,
  tileId: TileId,
): {
  readonly events: readonly HongKongGameEventV1[];
  readonly state: CanonicalGameStateV1;
} {
  const result = applyGameCommandV1(
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
  state: CanonicalGameStateV1,
  responder: Seat,
  response: ReactionResponse,
): {
  readonly events: readonly HongKongGameEventV1[];
  readonly state: CanonicalGameStateV1;
} {
  if (state.reactionWindow === null) throw new Error("No fixture window.");
  const publicResponse =
    response.type === "win" ? ({ type: "win" } as const) : response;
  const result = applyGameCommandV1(
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

const responseOrders: readonly (readonly Seat[])[] = [
  [seat("south"), seat("west"), seat("north")],
  [seat("south"), seat("north"), seat("west")],
  [seat("west"), seat("south"), seat("north")],
  [seat("west"), seat("north"), seat("south")],
  [seat("north"), seat("south"), seat("west")],
  [seat("north"), seat("west"), seat("south")],
];

function permutationResults(
  opened: CanonicalGameStateV1,
  choices: Readonly<Record<string, ReactionResponse>>,
): readonly string[] {
  return responseOrders.map((order) => {
    let state = opened;
    const emitted: HongKongGameEventV1[] = [];
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
        .map(canonicalGameEventJson),
      state: canonicalGameJson(state),
    });
  });
}

function expectVersionedRoundTrip(event: HongKongGameEventV1): void {
  const bytes = canonicalGameEventJson(event);
  expect(decodeCanonicalGameEventJson(bytes)).toEqual(event);
}

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
        startHongKongV1Game(actors, randomness(320)).state,
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
    const started = startHongKongV1Game(actors, randomness(319));
    let state = placeInHands(started.state, [
      { index: 0, seat: seat("east"), tileId: 5 as TileId },
      { index: 1, seat: seat("east"), tileId: 6 as TileId },
      { index: 2, seat: seat("east"), tileId: 7 as TileId },
      { index: 0, seat: seat("south"), tileId: 4 as TileId },
    ]);
    const genesis: HongKongGameEventV1 = {
      ...started.event,
      state,
    };
    const events: HongKongGameEventV1[] = [genesis];
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
    const drawn = applyGameCommandV1(state, state.players.south.actorId, {
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
      lastAcquisition: "kong-replacement",
      replacementChainDepth: 1,
      replacementPending: false,
    });
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      "game/reaction-intent-submitted",
      "game/reaction-resolved",
      "game/kong-replacement-drawn",
    ]);
    assertGameInvariants(state);
    expect(canonicalGameJson(replayGameEvents(events))).toBe(
      canonicalGameJson(state),
    );
  });

  it("rejects an invalid physical-ID matrix without consuming a response", () => {
    let state = placeInHands(
      startHongKongV1Game(actors, randomness(321)).state,
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
      const result = applyGameCommandV1(
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
      startHongKongV1Game(actors, randomness(325)).state,
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
        applyGameCommandV1(state, state.players.east.actorId, {
          type: "game/declare-concealed-kong",
          tileIds: tileIds as readonly [TileId, TileId, TileId, TileId],
        }),
      ).toMatchObject({ accepted: false });
    }
  });

  it("supports chained concealed kongs and preserves all physical tiles", () => {
    let state = placeInHands(
      startHongKongV1Game(actors, randomness(322)).state,
      [0, 1, 2, 3, 4, 5, 6, 7].map((tileId, index) => ({
        index,
        seat: seat("east"),
        tileId: tileId as TileId,
      })),
    );
    const events: HongKongGameEventV1[] = [];
    for (const tileIds of [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ] as const) {
      const result = applyGameCommandV1(state, state.players.east.actorId, {
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
      lastAcquisition: "kong-replacement",
      replacementChainDepth: 1,
      replacementPending: false,
    });
    expect(events.map((event) => event.type)).toEqual([
      "game/concealed-kong-declared",
      "game/kong-replacement-drawn",
      "game/concealed-kong-declared",
      "game/kong-replacement-drawn",
    ]);
  });

  it("keeps provisional scored-win validation implementation-only", () => {
    const westWinningWait = [
      0, 8, 36, 37, 38, 40, 41, 42, 44, 45, 46, 108, 109,
    ] as const;
    let state = placeInHands(
      startHongKongV1Game(actors, randomness(324)).state,
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
      applyGameCommandV1(state, state.players.south.actorId, {
        type: "game/propose-added-kong",
        meldId: "meld:forged",
        tileId: 7 as TileId,
      }),
    ).toMatchObject({ accepted: false });
    expect(
      applyGameCommandV1(state, state.players.south.actorId, {
        type: "game/propose-added-kong",
        meldId: pung.id,
        tileId: 99 as TileId,
      }),
    ).toMatchObject({ accepted: false });
    const proposal = applyGameCommandV1(state, state.players.south.actorId, {
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
    const withIntent = reduceGameEvent(state, intent);
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
    const reduced = reduceGameEvent(withIntent, event);
    expect(reduced.sequence).toBe(event.sequence);
    expect(reduced.phase).toBe("pending-win-validation");
    expect(reduced.reactionWindow).toEqual(withIntent.reactionWindow);
    expect(reduced.players.south.melds[0]).toEqual(pung);
    expect(reduced.players.south.hand).toContain(7);
    expect(reduced.players.west.hand).not.toContain(7);
    expect(() => projectGameV1(reduced, reduced.players.west.actorId)).toThrow(
      /implementation-only/iu,
    );
    expect(() => canonicalGameJson(reduced)).toThrow(/implementation-only/iu);
    const completion = resolution.events[1];
    if (completion?.type !== "game/hand-completed") {
      throw new Error("Rob resolution omitted scored completion.");
    }
    expectVersionedRoundTrip(completion);
    const complete = reduceGameEvent(reduced, completion);
    expect(complete).toMatchObject({ phase: "complete" });
    expect(decideReactionExpiration(reduced)).toMatchObject({
      accepted: false,
      error: { code: "no-reaction-window" },
    });
    expect(
      applyGameCommandV1(reduced, reduced.players.north.actorId, {
        type: "game/react",
        response: { type: "pass" },
        windowId: window.id,
      }),
    ).toMatchObject({ accepted: false });
    expect(() =>
      reduceGameEvent(reduced, {
        ...event,
        sequence: reduced.sequence + 1,
      }),
    ).toThrow(/closed window/iu);
    expect(() =>
      reduceGameEvent(reduced, {
        actorId: reduced.players.north.actorId,
        response: { type: "pass" },
        seat: seat("north"),
        sequence: reduced.sequence + 1,
        type: "game/reaction-intent-submitted",
        windowId: window.id,
      }),
    ).toThrow(/not valid/iu);
    assertGameInvariants(reduced);
    expect(decodeCanonicalGameEventJson(canonicalGameEventJson(event))).toEqual(
      event,
    );
  });

  it("round-trips every emitted event and rejects forged reducer transitions", () => {
    let state = placeInHands(
      startHongKongV1Game(actors, randomness(323)).state,
      [
        { index: 0, seat: seat("east"), tileId: 4 as TileId },
        { index: 0, seat: seat("west"), tileId: 5 as TileId },
        { index: 1, seat: seat("west"), tileId: 6 as TileId },
        { index: 2, seat: seat("west"), tileId: 7 as TileId },
      ],
    );
    const genesis = {
      ...startHongKongV1Game(actors, randomness(323)).event,
      state,
    };
    const opened = openDiscard(state, 4 as TileId);
    const reactionState = opened.state;
    const allEvents: HongKongGameEventV1[] = [genesis, ...opened.events];
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
      const bytes = canonicalGameEventJson(event);
      expect(decodeCanonicalGameEventJson(bytes)).toEqual(event);
    }
    expect(canonicalGameJson(replayGameEvents(allEvents))).toBe(
      canonicalGameJson(state),
    );
    const openedEvent = opened.events[0];
    if (openedEvent?.type !== "game/discard-reaction-opened") {
      throw new Error("Expected discard-open event.");
    }
    expect(() =>
      reduceGameEvent(
        placeInHands(startHongKongV1Game(actors, randomness(323)).state, [
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
      reduceGameEvent(reactionState, {
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
      reduceGameEvent(reactionState, {
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
    const pending = replayGameEvents(allEvents.slice(0, replacementIndex));
    expect(() =>
      reduceGameEvent(pending, {
        ...replacement,
        tileIds: [99 as TileId],
      }),
    ).toThrow();
  });

  it("runs seeded legal claim/kong simulations with invariant and replay checks", () => {
    let observedClaims = 0;
    let observedKongs = 0;
    for (const seed of [331, 337, 349, 353]) {
      const started = startHongKongV1Game(actors, randomness(seed));
      let state = placeInHands(
        started.state,
        [0, 1, 2, 3].map((tileId, index) => ({
          index,
          seat: seat("east"),
          tileId: tileId as TileId,
        })),
      );
      const events: HongKongGameEventV1[] = [{ ...started.event, state }];
      let cursor = seed >>> 0;
      const choose = <Value>(values: readonly Value[]): Value => {
        cursor = (Math.imul(cursor, 1_664_525) + 1_013_904_223) >>> 0;
        const value = values[cursor % values.length];
        if (value === undefined) throw new Error("Seeded choice was empty.");
        return value;
      };
      let steps = 0;
      while (state.phase !== "exhausted" && steps < 500) {
        let batch: readonly HongKongGameEventV1[];
        let next: CanonicalGameStateV1;
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
          const result = applyGameCommandV1(state, actorId, {
            type: "game/draw",
          });
          if (!result.accepted || result.state === undefined)
            throw new Error("Seeded draw failed.");
          batch = result.events;
          next = result.state;
        } else {
          const player = playerAt(state.players, state.turn);
          const selfView = projectGameV1(state, player.actorId);
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
          const result = applyGameCommandV1(state, player.actorId, action);
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
      expect(canonicalGameJson(replayGameEvents(events))).toBe(
        canonicalGameJson(state),
      );
    }
    expect(observedClaims).toBeGreaterThan(0);
    expect(observedKongs).toBeGreaterThan(0);
  });
});
