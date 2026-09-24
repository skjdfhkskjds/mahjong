import { describe, expect, it, vi } from "vitest";
import type { GameViewV1 } from "@mahjong/rules-hong-kong";
import type { PlayerControl } from "../../src/worker/durable-objects/table-room/table-player-control.js";
import { BotPlayer } from "../../src/worker/players/bot-player.js";
import type {
  PlayerInput,
  PlayerView,
} from "../../src/worker/players/player.js";
import {
  TablePlayers,
  type PlayerCommandResult,
} from "../../src/worker/players/table-players.js";
import type { UserConnection } from "../../src/worker/players/user-player.js";

const game: GameViewV1 = {
  phase: "awaiting-draw",
  players: [],
  turn: "east" as GameViewV1["turn"],
  wallRemaining: 40,
  viewerActions: { self: [{ type: "game/draw" }] },
};
const command = {
  commandId: "command",
  expectedStateVersion: 4,
  command: { type: "game/draw" },
} as const;

function room() {
  let control: PlayerControl = {
    actorId: "human",
    kind: "HUMAN",
    controller: "HUMAN",
    generation: 1,
  };
  let connections: readonly UserConnection[] = [
    { id: "first", usable: true },
    { id: "second", usable: true },
  ];
  let view: PlayerView = {
    type: "view",
    stateVersion: 4,
    snapshot: "own permitted view",
    game,
  };
  const messages: {
    readonly actorId: string;
    readonly connectionId: string;
    readonly input: PlayerInput;
  }[] = [];
  const apply = vi.fn((): Promise<PlayerCommandResult> =>
    Promise.resolve({
      applied: true,
      broadcast: false,
      response: "private receipt",
      senderSnapshot: true,
      stale: false,
    }),
  );
  const choose = vi.fn(
    (permitted: GameViewV1) => permitted.viewerActions?.self[0],
  );
  const players = new TablePlayers({
    control: (actorId) => ({ ...control, actorId }),
    view: () => view,
    communication: (actorId) => ({
      connections: () =>
        actorId === "human" ? connections : [{ id: "other", usable: true }],
      send: (connectionId, input) => {
        messages.push({ actorId, connectionId, input });
      },
    }),
    choose,
    apply,
  });
  return {
    players,
    messages,
    apply,
    choose,
    control(next: PlayerControl) {
      control = next;
    },
    connections(next: readonly UserConnection[]) {
      connections = next;
    },
    view(next: PlayerView) {
      view = next;
    },
  };
}

describe("table player output routing", () => {
  it("publishes exactly once per recovered connection and once per subsequent broadcast", () => {
    const table = room();
    table.players.publish("human");
    expect(table.messages.map(({ connectionId }) => connectionId)).toEqual([
      "first",
      "second",
    ]);
    table.players.publish("human");
    expect(table.messages.map(({ connectionId }) => connectionId)).toEqual([
      "first",
      "second",
      "first",
      "second",
    ]);
    expect(table.apply).not.toHaveBeenCalled();
  });

  it("initializes a reconnecting socket once and excludes it from the public transition broadcast", () => {
    const table = room();
    table.players.snapshot("human", "first");
    table.control({
      actorId: "human",
      kind: "HUMAN",
      controller: "HUMAN",
      generation: 2,
    });
    table.players.snapshot("human", "second");
    table.players.publish("human", "second");
    expect(table.messages.map(({ connectionId }) => connectionId)).toEqual([
      "first",
      "second",
      "first",
    ]);
  });

  it("delivers a private receipt only to its origin after that accepted command revokes the grant", async () => {
    const table = room();
    table.players.publish("human");
    table.players.publish("other-player");
    expect(await table.players.human("human", "first", command)).toMatchObject({
      applied: true,
    });
    table.connections([
      { id: "first", usable: false },
      { id: "second", usable: true },
    ]);
    table.players.outcome("human", "first", "private receipt");
    table.players.outcome("human", "other", "must not cross actor boundary");
    expect(
      table.messages.filter(({ input }) => input.type === "outcome"),
    ).toEqual([
      {
        actorId: "human",
        connectionId: "first",
        input: {
          type: "outcome",
          message: "private receipt",
          connectionIds: ["first"],
        },
      },
    ]);
    expect(
      await table.players.human("human", "first", command),
    ).toBeUndefined();
    expect(table.apply).toHaveBeenCalledTimes(1);
  });

  it("targets private snapshots and never sends them to another initialized connection", () => {
    const table = room();
    table.players.publish("human");
    table.messages.length = 0;
    table.players.snapshot("human", "second");
    expect(table.messages).toHaveLength(1);
    expect(table.messages[0]?.connectionId).toBe("second");
  });

  it("observes all usable connections before initialization without changing persisted authority or emitting a snapshot", () => {
    const table = room();
    table.control({
      actorId: "human",
      kind: "HUMAN",
      controller: "BOT",
      generation: 8,
    });
    expect(table.players.health("human")).toEqual({
      available: true,
      desiredController: "HUMAN",
      authority: { kind: "BOT", generation: 8 },
    });
    expect(table.messages).toEqual([]);
    expect(table.apply).not.toHaveBeenCalled();
    table.connections([
      { id: "first", usable: false },
      { id: "second", usable: true },
    ]);
    expect(table.players.health("human").desiredController).toBe("HUMAN");
    table.connections([
      { id: "first", usable: false },
      { id: "second", usable: false },
    ]);
    expect(table.players.health("human").desiredController).toBe("BOT");
    expect(table.players.health("human").authority).toEqual({
      kind: "BOT",
      generation: 8,
    });
  });

  it("routes a bot outcome through its player without exposing it to human sockets", async () => {
    const table = room();
    table.control({
      actorId: "human",
      kind: "HUMAN",
      controller: "BOT",
      generation: 8,
    });
    const receive = vi.spyOn(BotPlayer.prototype, "receive");
    try {
      expect(await table.players.bot("human", 8, "command", 4)).toMatchObject({
        applied: true,
      });
      expect(receive).toHaveBeenCalledWith({
        type: "outcome",
        message: "private receipt",
      });
      expect(table.choose).toHaveBeenCalledWith(game);
      expect(table.messages).toEqual([]);
    } finally {
      receive.mockRestore();
    }
  });
});
