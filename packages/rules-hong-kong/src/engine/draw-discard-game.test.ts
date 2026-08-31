import { tileId } from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import {
  applyGameCommand,
  assertGameInvariants,
  canonicalEventHashPayload,
  canonicalGameEventJson,
  canonicalGameJson,
  decodeCanonicalGameEventJson,
  decodeCanonicalGameJson,
  projectGame,
  replayGameEvents,
  reduceGameEvent,
  startHongKongV1Game,
  type CanonicalGameState,
  type HongKongGameEvent,
  type SeatMap,
} from "./draw-discard-game.js";

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

describe("hong-kong/v1 hidden-state draw/discard game", () => {
  it("deals four distinct private structural hands and exposes bonuses", () => {
    const { state } = startHongKongV1Game(actors, randomness(1));
    expect(state.phase).toBe("awaiting-dealer-discard");
    expect(state.players.east.hand).toHaveLength(14);
    expect(state.players.south.hand).toHaveLength(13);
    expect(state.players.west.hand).toHaveLength(13);
    expect(state.players.north.hand).toHaveLength(13);
    expect(
      state.players.east.bonuses.length +
        state.players.south.bonuses.length +
        state.players.west.bonuses.length +
        state.players.north.bonuses.length,
    ).toBeGreaterThan(0);
    assertGameInvariants(state);
  });

  it("projects only the viewer's concealed hand and never the wall", () => {
    const { state } = startHongKongV1Game(actors, randomness(2));
    const east = projectGame(state, state.players.east.actorId);
    const spectator = projectGame(state, "actor:spectator");
    expect(east.viewerHand).toHaveLength(14);
    expect(spectator).not.toHaveProperty("viewerHand");
    expect(east).not.toHaveProperty("wall.order");
    expect(JSON.stringify(spectator)).not.toContain(actors.east);
    expect(
      spectator.players.map(({ concealedCount }) => concealedCount),
    ).toEqual([14, 13, 13, 13]);
  });

  it("is noninterfering when opponents' hidden hand contents change", () => {
    const { state } = startHongKongV1Game(actors, randomness(3));
    const southTile = state.players.south.hand[0];
    const westTile = state.players.west.hand[0];
    if (southTile === undefined || westTile === undefined) {
      throw new Error("Opponents received no concealed tiles.");
    }
    const altered: CanonicalGameState = {
      ...state,
      players: {
        ...state.players,
        south: {
          ...state.players.south,
          hand: [westTile, ...state.players.south.hand.slice(1)],
        },
        west: {
          ...state.players.west,
          hand: [southTile, ...state.players.west.hand.slice(1)],
        },
      },
    };
    assertGameInvariants(altered);
    expect(projectGame(altered, state.players.east.actorId)).toEqual(
      projectGame(state, state.players.east.actorId),
    );
    expect(projectGame(altered, "spectator")).toEqual(
      projectGame(state, "spectator"),
    );
  });

  it("runs multiple deterministic random games through exhaustion", () => {
    for (const offset of [4, 19, 53, 101, 197]) {
      const started = startHongKongV1Game(actors, randomness(offset));
      let state = started.state;
      const events: HongKongGameEvent[] = [started.event];
      let turns = 0;
      while (state.phase !== "exhausted" && turns < 200) {
        const current = state.players[state.turn as keyof SeatMap<unknown>];
        const actor = current.actorId;
        const discardIndex = (turns * 17 + offset) % current.hand.length;
        const command =
          state.phase === "awaiting-draw"
            ? ({ type: "game/draw" } as const)
            : ({
                type: "game/discard",
                tileId: current.hand[discardIndex] ?? tileId(999),
              } as const);
        const decision = applyGameCommand(state, actor, command);
        expect(decision.accepted).toBe(true);
        if (!decision.accepted || decision.state === undefined) break;
        events.push(decision.event);
        state = decision.state;
        assertGameInvariants(state);
        turns += 1;
      }
      expect(turns).toBeGreaterThan(100);
      expect(state.phase).toBe("exhausted");
      expect(events.at(-1)?.type).toBe("game/wall-exhausted");
      expect(canonicalGameJson(replayGameEvents(events))).toBe(
        canonicalGameJson(state),
      );
    }
  });

  it("rejects wrong actors, wrong phases, and absent physical tile IDs", () => {
    const { state } = startHongKongV1Game(actors, randomness(5));
    expect(
      applyGameCommand(state, state.players.south.actorId, {
        type: "game/draw",
      }),
    ).toMatchObject({
      accepted: false,
      error: { code: "not-your-turn" },
    });
    expect(
      applyGameCommand(state, state.players.east.actorId, {
        type: "game/draw",
      }),
    ).toMatchObject({
      accepted: false,
      error: { code: "draw-not-allowed" },
    });
    expect(
      applyGameCommand(state, state.players.east.actorId, {
        type: "game/discard",
        tileId: tileId(999),
      }),
    ).toMatchObject({ accepted: false, error: { code: "tile-not-in-hand" } });
  });

  it("round-trips canonical JSON and rejects duplicate tile locations", () => {
    const { state } = startHongKongV1Game(actors, randomness(6));
    expect(
      canonicalGameJson(decodeCanonicalGameJson(canonicalGameJson(state))),
    ).toBe(canonicalGameJson(state));
    expect(() =>
      decodeCanonicalGameJson(JSON.stringify(state, null, 2)),
    ).toThrow("not canonical");
    const borrowed = state.players.south.hand[0];
    if (borrowed === undefined) throw new Error("South received no tiles.");
    const duplicate: CanonicalGameState = {
      ...state,
      players: {
        ...state.players,
        east: {
          ...state.players.east,
          hand: [...state.players.east.hand, borrowed],
        },
      },
    };
    expect(() => {
      assertGameInvariants(duplicate);
    }).toThrow("exactly one location");
  });

  it("formats byte-stable versioned SHA-256 chain inputs", () => {
    const { event } = startHongKongV1Game(actors, randomness(7));
    const first = canonicalEventHashPayload(null, event);
    expect(canonicalEventHashPayload(null, event)).toBe(first);
    expect(first).toMatch(/^\{"event":.*,"previousHash":null,"version":1\}$/u);
    expect(canonicalEventHashPayload("0".repeat(64), event)).not.toBe(first);
    expect(() => canonicalEventHashPayload("not-a-hash", event)).toThrow(
      "Previous event hash",
    );
  });

  it("strictly decodes canonical events and rejects forged transitions", () => {
    const started = startHongKongV1Game(actors, randomness(8));
    const bytes = canonicalGameEventJson(started.event);
    expect(decodeCanonicalGameEventJson(bytes)).toEqual(started.event);
    expect(() =>
      decodeCanonicalGameEventJson(JSON.stringify(started.event)),
    ).toThrow("not canonical");
    expect(() =>
      canonicalGameEventJson({
        ...started.event,
        state: { ...started.state, sequence: 2 },
      }),
    ).toThrow();

    const opening = started.state.players.east.hand[0];
    if (opening === undefined) throw new Error("Dealer has no opening tile.");
    const discarded = applyGameCommand(
      started.state,
      started.state.players.east.actorId,
      { type: "game/discard", tileId: opening },
    );
    if (!discarded.accepted || discarded.state === undefined)
      throw new Error("Opening discard failed.");
    const afterDiscard = discarded.state;
    const order = [...afterDiscard.wall.order];
    const liveIndexes = order
      .map((id, index) => ({ id, index }))
      .filter(
        ({ index }) =>
          index >= afterDiscard.wall.head && index <= afterDiscard.wall.tail,
      );
    const bonusIndexes = liveIndexes
      .filter(({ id }) => id >= 136)
      .map(({ index }) => index);
    const structuralIndex = liveIndexes.find(({ id }) => id < 136)?.index;
    if (bonusIndexes.length < 3 || structuralIndex === undefined)
      throw new Error("Test wall lacks replacement fixtures.");
    const targets = [
      afterDiscard.wall.head,
      afterDiscard.wall.tail,
      afterDiscard.wall.tail - 1,
      afterDiscard.wall.tail - 2,
    ];
    const desired = [
      order[bonusIndexes[0] ?? -1],
      order[bonusIndexes[1] ?? -1],
      order[bonusIndexes[2] ?? -1],
      order[structuralIndex],
    ];
    for (const [index, target] of targets.entries()) {
      const desiredTile = desired[index];
      if (desiredTile === undefined) continue;
      const source = order.indexOf(desiredTile);
      if (source < 0) throw new Error("Replacement fixture tile disappeared.");
      const sourceValue = order[source];
      const targetValue = order[target];
      if (sourceValue === undefined || targetValue === undefined)
        throw new Error("Replacement fixture index escaped the wall.");
      order[target] = sourceValue;
      order[source] = targetValue;
    }
    const replacementState: CanonicalGameState = {
      ...afterDiscard,
      wall: { ...afterDiscard.wall, order },
    };
    assertGameInvariants(replacementState);
    const recursive = applyGameCommand(
      replacementState,
      replacementState.players.south.actorId,
      { type: "game/draw" },
    );
    if (!recursive.accepted || recursive.event.type !== "game/turn-drawn")
      throw new Error("Recursive replacement failed.");
    expect(recursive.event.replacementTileIds).toHaveLength(3);
    const draw = applyGameCommand(
      discarded.state,
      discarded.state.players.south.actorId,
      { type: "game/draw" },
    );
    if (!draw.accepted || draw.event.type !== "game/turn-drawn")
      throw new Error("South draw failed.");
    const tailTile = discarded.state.wall.order[discarded.state.wall.tail];
    if (tailTile === undefined) throw new Error("Test wall is empty.");
    const forged = {
      ...draw.event,
      replacementTileIds: [tailTile],
    } as typeof draw.event;
    expect(() => reduceGameEvent(discarded.state, forged)).toThrow(
      /replacement chain|replacement outcome/iu,
    );
  });
});
