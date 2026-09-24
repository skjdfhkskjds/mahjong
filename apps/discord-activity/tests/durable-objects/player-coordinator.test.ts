import { describe, expect, it, vi } from "vitest";
import type {
  GameViewV1,
  HongKongGameCommandV1,
} from "@mahjong/rules-hong-kong";
import type { TableCommandEnvelope } from "../../src/worker/durable-objects/table-room/table-room-protocol.js";
import {
  BotPlayer,
  type BotDecision,
} from "../../src/worker/players/bot-player.js";
import { PlayerCoordinator } from "../../src/worker/players/player-coordinator.js";
import type {
  Player,
  PlayerInput,
  PlayerView,
} from "../../src/worker/players/player.js";
import {
  UserPlayer,
  type UserConnection,
} from "../../src/worker/players/user-player.js";

const game: GameViewV1 = {
  phase: "awaiting-draw",
  players: [],
  turn: "east" as GameViewV1["turn"],
  wallRemaining: 40,
  viewerActions: { self: [{ type: "game/draw" }] },
};
const view: PlayerView = {
  type: "view",
  stateVersion: 7,
  game,
  snapshot: "permitted snapshot",
};
const command: TableCommandEnvelope = {
  commandId: "command",
  expectedStateVersion: 7,
  command: { type: "game/draw" },
};

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    complete(value: T) {
      if (!resolve) throw new Error("Missing deferred resolver.");
      resolve(value);
    },
  };
}

function fixture(
  decision: BotDecision = {
    choose: (permitted) => permitted.viewerActions?.self[0],
  },
) {
  let connections: readonly UserConnection[] = [{ id: "first", usable: true }];
  const messages: { readonly id: string; readonly input: PlayerInput }[] = [];
  const commands: TableCommandEnvelope[] = [];
  const user = new UserPlayer("same-player", {
    connections: () => connections,
    send: (id, input) => {
      messages.push({ id, input });
    },
  });
  const bot = new BotPlayer("same-player", decision);
  const coordinator = new PlayerCoordinator("same-player", user, bot);
  coordinator.onCommand((submitted) => {
    commands.push(submitted);
    return Promise.resolve();
  });
  return {
    user,
    bot,
    coordinator,
    messages,
    commands,
    connections(next: readonly UserConnection[]) {
      connections = next;
    },
  };
}

describe("player communication and controller arbitration", () => {
  it("implements one communication contract and requires snapshot initialization before human commands", async () => {
    const { user, bot, coordinator, commands, messages } = fixture();
    const players: readonly Player[] = [user, bot, coordinator];
    expect(players.map(({ actorId }) => actorId)).toEqual(
      Array(3).fill("same-player"),
    );
    coordinator.activate("HUMAN", 1, view);
    expect(coordinator.checkHealth()).toBe("HUMAN");
    expect(await user.submit("first", command)).toBe(false);
    expect(user.initialize("first", view)).toBe(true);
    expect(messages).toEqual([{ id: "first", input: view }]);
    expect(coordinator.checkHealth()).toBe("HUMAN");
    expect(await user.submit("first", command)).toBe(true);
    expect(commands).toEqual([command]);
  });

  it("counts every usable initialized connection and follows supplied expiry evidence", async () => {
    const room = fixture();
    room.connections([
      { id: "first", usable: true },
      { id: "second", usable: true },
    ]);
    room.coordinator.activate("HUMAN", 1, view);
    room.user.initialize("first", view);
    room.user.initialize("second", view);
    room.connections([
      { id: "first", usable: false },
      { id: "second", usable: true },
    ]);
    expect(room.coordinator.checkHealth()).toBe("HUMAN");
    expect(await room.user.submit("first", command)).toBe(false);
    expect(await room.user.submit("second", command)).toBe(true);
    room.connections([
      { id: "first", usable: false },
      { id: "second", usable: false },
    ]);
    expect(room.coordinator.checkHealth()).toBe("BOT");
    room.coordinator.activate("BOT", 2, view);
    expect(await room.bot.run(command)).toBe(true);
    expect(room.commands).toEqual([command, command]);
    expect(room.coordinator.actorId).toBe("same-player");
  });

  it("keeps an explicitly departed open connection unavailable until a fresh initialization", async () => {
    const room = fixture();
    room.coordinator.activate("HUMAN", 3, view);
    room.user.initialize("first", view);
    room.user.depart();
    expect(room.coordinator.checkHealth()).toBe("BOT");
    expect(await room.user.submit("first", command)).toBe(false);
    room.coordinator.activate("BOT", 4, view);
    room.coordinator.activate("HUMAN", 5, view);
    expect(await room.user.submit("first", command)).toBe(false);
    room.user.initialize("first", view);
    expect(await room.user.submit("first", command)).toBe(true);
    expect(
      room.messages.filter(({ input }) => input.type === "view"),
    ).toHaveLength(2);
  });

  it("rejects late bot decisions after reconnection and permits one new job after a rapid second handoff", async () => {
    const first = deferred<HongKongGameCommandV1 | undefined>();
    const second = deferred<HongKongGameCommandV1 | undefined>();
    const choose = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const room = fixture({ choose });
    room.coordinator.activate("BOT", 4, view);
    const old = room.bot.run({ commandId: "old", expectedStateVersion: 7 });
    expect(
      await room.bot.run({ commandId: "duplicate", expectedStateVersion: 7 }),
    ).toBe(false);
    room.coordinator.activate("HUMAN", 5, view);
    room.user.initialize("first", view);
    room.user.depart();
    room.coordinator.activate("BOT", 6, view);
    const current = room.bot.run(command);
    first.complete({ type: "game/draw" });
    expect(await old).toBe(false);
    expect(room.commands).toEqual([]);
    second.complete({ type: "game/draw" });
    expect(await current).toBe(true);
    expect(room.commands).toEqual([command]);
    expect(choose).toHaveBeenCalledTimes(2);
  });

  it("does not restart bot work on repeated health notifications or same-generation activation", async () => {
    const choice = deferred<HongKongGameCommandV1 | undefined>();
    const choose = vi.fn(() => choice.promise);
    const room = fixture({ choose });
    room.connections([]);
    room.coordinator.activate("BOT", 10, view);
    const pending = room.bot.run(command);
    expect(room.coordinator.checkHealth()).toBe("BOT");
    room.coordinator.activate("BOT", 10, view);
    expect(await room.bot.run(command)).toBe(false);
    choice.complete({ type: "game/draw" });
    expect(await pending).toBe(true);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(room.commands).toEqual([command]);
  });

  it("invalidates a pending policy decision when its permitted view changes privately", async () => {
    const choice = deferred<HongKongGameCommandV1 | undefined>();
    const room = fixture({ choose: () => choice.promise });
    room.coordinator.activate("BOT", 1, view);
    const pending = room.bot.run(command);
    room.coordinator.receive({
      ...view,
      game: { ...game, viewerActions: { self: [] } },
    });
    choice.complete({ type: "game/draw" });
    expect(await pending).toBe(false);
    expect(room.commands).toEqual([]);
  });

  it("leaves already forwarded commands accepted and exposes an authority guard for queued runtime work", async () => {
    const room = fixture();
    room.coordinator.activate("HUMAN", 1, view);
    room.user.initialize("first", view);
    expect(await room.user.submit("first", command)).toBe(true);
    room.coordinator.activate("BOT", 2, view);
    expect(room.commands).toEqual([command]);
    expect(room.coordinator.isCurrent("HUMAN", 1)).toBe(false);
    expect(room.coordinator.isCurrent("BOT", 2)).toBe(true);
    expect(
      await room.user.submit("first", { ...command, commandId: "late" }),
    ).toBe(false);
  });

  it("rejects replaced connection authorization and routes outcomes only to current initialized connections", async () => {
    const room = fixture();
    room.coordinator.activate("HUMAN", 1, view);
    room.user.initialize("first", view);
    room.connections([{ id: "replacement", usable: true }]);
    expect(await room.user.submit("first", command)).toBe(false);
    expect(await room.user.submit("replacement", command)).toBe(false);
    room.user.initialize("replacement", view);
    const outcome = { type: "outcome", message: "permitted receipt" } as const;
    room.coordinator.receive(outcome);
    expect(
      room.messages.filter(({ input }) => input.type === "outcome"),
    ).toEqual([{ id: "replacement", input: outcome }]);
    expect(await room.user.submit("replacement", command)).toBe(true);
  });

  it("never submits during synchronous initialization or after initialization loses authorization", async () => {
    let usable = true;
    const attempts: Promise<boolean>[] = [];
    const user = new UserPlayer("player", {
      connections: () => [{ id: "connection", usable }],
      send: () => {
        attempts.push(user.submit("connection", command));
        usable = false;
      },
    });
    const submitted = vi.fn(() => Promise.resolve());
    user.onCommand(submitted);
    expect(user.initialize("connection", view)).toBe(false);
    expect(await Promise.all(attempts)).toEqual([false]);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("cleans up routing and invalidates pending work before reconstruction at a persisted generation", async () => {
    const choice = deferred<HongKongGameCommandV1 | undefined>();
    const old = fixture({ choose: () => choice.promise });
    old.coordinator.activate("BOT", 9, view);
    const pending = old.bot.run(command);
    old.coordinator.dispose();
    old.coordinator.dispose();
    const recovered = fixture();
    recovered.coordinator.activate("BOT", 9, view);
    choice.complete({ type: "game/draw" });
    expect(await pending).toBe(false);
    expect(old.commands).toEqual([]);
    expect(old.coordinator.isCurrent("BOT", 9)).toBe(false);
    expect(await recovered.bot.run(command)).toBe(true);
    expect(recovered.commands).toEqual([command]);
    expect(() => old.coordinator.onCommand(() => Promise.resolve())).toThrow(
      "disposed",
    );
  });

  it("rejects mismatched identities and non-monotonic controller generations", () => {
    const room = fixture();
    expect(
      () => new PlayerCoordinator("different", room.user, room.bot),
    ).toThrow("identity");
    room.coordinator.activate("BOT", 3, view);
    for (const generation of [2, 3])
      expect(() => {
        room.coordinator.activate("HUMAN", generation, view);
      }).toThrow("advance");
    for (const generation of [-1, NaN, Infinity, 1.5])
      expect(() => {
        room.coordinator.activate("BOT", generation, view);
      }).toThrow("Invalid");
  });

  it("does not run inactive policies or policies against a different public version", async () => {
    const choose = vi.fn(() => ({ type: "game/draw" }) as const);
    const room = fixture({ choose });
    room.bot.receive(view);
    expect(await room.bot.run(command)).toBe(false);
    room.coordinator.activate("BOT", 1, view);
    expect(await room.bot.run({ ...command, expectedStateVersion: 6 })).toBe(
      false,
    );
    expect(choose).not.toHaveBeenCalled();
  });

  it("isolates a failed connection while a healthy connection receives views and submits", async () => {
    let failFirst = false;
    const delivered: string[] = [];
    const user = new UserPlayer("player", {
      connections: () => [
        { id: "bad", usable: true },
        { id: "healthy", usable: true },
      ],
      send: (id) => {
        if (id === "bad" && failFirst) throw new Error("closed transport");
        delivered.push(id);
      },
    });
    const bot = new BotPlayer("player", { choose: () => undefined });
    const coordinator = new PlayerCoordinator("player", user, bot);
    const submitted = vi.fn(() => Promise.resolve());
    coordinator.onCommand(submitted);
    user.initialize("bad", view);
    user.initialize("healthy", view);
    coordinator.activate("BOT", 1, view);
    failFirst = true;
    expect(() => {
      coordinator.activate("HUMAN", 2, view);
    }).not.toThrow();
    expect(delivered).toEqual(["bad", "healthy", "healthy"]);
    expect(coordinator.checkHealth()).toBe("HUMAN");
    expect(user.isInitialized("bad")).toBe(false);
    expect(await user.submit("bad", command)).toBe(false);
    expect(await user.submit("healthy", command)).toBe(true);
    expect(user.initialize("bad", view)).toBe(false);
    failFirst = false;
    expect(user.initialize("bad", view)).toBe(true);
    expect(await user.submit("bad", command)).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(2);
  });

  it("retries failed activation at the same persisted generation without restoring old authority", async () => {
    const room = fixture();
    room.user.initialize("first", view);
    room.coordinator.activate("BOT", 1, view);
    const receive = vi
      .spyOn(room.user, "receive")
      .mockImplementationOnce(() => {
        throw new Error("initialization interrupted");
      });
    expect(() => {
      room.coordinator.activate("HUMAN", 2, view);
    }).toThrow("initialization interrupted");
    expect(room.coordinator.current).toBeUndefined();
    expect(room.coordinator.isCurrent("HUMAN", 2)).toBe(false);
    expect(await room.user.submit("first", command)).toBe(false);
    expect(await room.bot.run(command)).toBe(false);
    expect(() => {
      room.coordinator.activate("BOT", 1, view);
    }).toThrow("advance");
    room.coordinator.activate("HUMAN", 2, view);
    expect(room.coordinator.isCurrent("HUMAN", 2)).toBe(true);
    expect(await room.user.submit("first", command)).toBe(true);
    expect(room.commands).toEqual([command]);
    receive.mockRestore();
  });
});
