import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTableSocketUrl,
  parseTableReceipt,
  parseTableSnapshot,
  ReconnectingSocketStatusMonitor,
} from "./table-socket-status.js";

const snapshot = {
  type: "table/snapshot",
  protocolVersion: 1,
  stateVersion: 0,
  view: {
    phase: "lobby",
    seats: [
      { seat: "east", occupant: null, ready: false },
      { seat: "south", occupant: null, ready: false },
      { seat: "west", occupant: null, ready: false },
      { seat: "north", occupant: null, ready: false },
    ],
    spectators: [{ id: "mock:1", displayName: "Local Player" }],
    tableId: "walking-skeleton",
    viewer: {
      role: "spectator",
      actor: { id: "mock:1", displayName: "Local Player" },
    },
  },
} as const;

class FakeSocket {
  public closed = false;
  public closeCode: number | undefined;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  public addEventListener(
    type: string,
    listener: (event: Event) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }

  public send(value: string): void {
    this.sent.push(value);
  }

  public emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("viewer-safe table snapshots", () => {
  it("builds a server-resolved table socket URL without a table locator", () => {
    expect(
      createTableSocketUrl("", { origin: "https://activity.example" }),
    ).toBe("wss://activity.example/api/table/socket");
  });

  it("parses the walking-skeleton lobby projection", () => {
    expect(parseTableSnapshot(snapshot)).toEqual({
      type: "table/snapshot",
      protocolVersion: 1,
      stateVersion: 0,
      view: {
        phase: "lobby",
        tableId: "walking-skeleton",
        seats: [
          { seat: "east", occupant: null, ready: false },
          { seat: "south", occupant: null, ready: false },
          { seat: "west", occupant: null, ready: false },
          { seat: "north", occupant: null, ready: false },
        ],
        spectators: [{ id: "mock:1", displayName: "Local Player" }],
        viewer: {
          role: "spectator",
          actor: { id: "mock:1", displayName: "Local Player" },
        },
      },
    });
  });

  it("rejects a projection without a viewer identity", () => {
    expect(() =>
      parseTableSnapshot({
        type: "table/snapshot",
        protocolVersion: 1,
        stateVersion: 0,
        view: {
          phase: "lobby",
          tableId: "walking-skeleton",
          seats: snapshot.view.seats,
          spectators: snapshot.view.spectators,
        },
      }),
    ).toThrow("view");
  });

  it("rejects an unsupported protocol version", () => {
    expect(() =>
      parseTableSnapshot({ ...snapshot, protocolVersion: 2 }),
    ).toThrow("version");
  });

  it("parses a player projection when the viewer matches the occupied seat", () => {
    const actor = { id: "mock:2", displayName: "East Player" };
    expect(
      parseTableSnapshot({
        ...snapshot,
        stateVersion: 4,
        view: {
          ...snapshot.view,
          seats: [
            { seat: "east", occupant: actor, ready: true },
            ...snapshot.view.seats.slice(1),
          ],
          spectators: snapshot.view.spectators,
          viewer: { actor, role: "player", seat: "east" },
        },
      }).view.viewer,
    ).toEqual({ actor, role: "player", seat: "east" });
  });

  it("strictly parses a private gameplay projection", () => {
    const actors = [
      { id: "mock:east", displayName: "East Player" },
      { id: "mock:south", displayName: "South Player" },
      { id: "mock:west", displayName: "West Player" },
      { id: "mock:north", displayName: "North Player" },
    ] as const;
    const gameSnapshot = {
      ...snapshot,
      stateVersion: 12,
      view: {
        ...snapshot.view,
        phase: "playing",
        game: {
          phase: "awaiting-dealer-discard",
          players: ["east", "south", "west", "north"].map((seat, index) => ({
            bonuses: [],
            concealedCount: index === 0 ? 1 : 13,
            discards: [],
            seat,
          })),
          turn: "east",
          viewerHand: [
            {
              id: 0,
              kind: { type: "suited", suit: "characters", rank: 1 },
            },
          ],
          wallRemaining: 87,
        },
        seats: ["east", "south", "west", "north"].map((seat, index) => ({
          seat,
          occupant: actors[index],
          ready: true,
        })),
        spectators: [],
        viewer: { actor: actors[0], role: "player", seat: "east" },
      },
    };
    expect(parseTableSnapshot(gameSnapshot).view.game).toMatchObject({
      phase: "awaiting-dealer-discard",
      turn: "east",
      viewerHand: [{ id: 0 }],
      wallRemaining: 87,
    });
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: { ...gameSnapshot.view.game, wall: { order: [1, 2, 3] } },
        },
      }),
    ).toThrow("game view");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: {
            ...gameSnapshot.view.game,
            viewerHand: [
              {
                id: 0,
                kind: {
                  type: "suited",
                  suit: "characters",
                  rank: 1,
                  canonicalCopy: 0,
                },
              },
            ],
          },
        },
      }),
    ).toThrow("public tile");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: {
            ...gameSnapshot.view.game,
            viewerHand: [
              {
                id: 0,
                kind: { type: "suited", suit: "characters", rank: 2 },
              },
            ],
          },
        },
      }),
    ).toThrow("does not match");
    const spectator = { id: "mock:viewer", displayName: "Spectator" };
    const spectatorSnapshot = {
      ...gameSnapshot,
      view: {
        ...gameSnapshot.view,
        game: { ...gameSnapshot.view.game, viewerHand: undefined },
        spectators: [spectator],
        viewer: { actor: spectator, role: "spectator" },
      },
    };
    expect(parseTableSnapshot(spectatorSnapshot).view.game).not.toHaveProperty(
      "viewerHand",
    );
    expect(() =>
      parseTableSnapshot({
        ...spectatorSnapshot,
        view: {
          ...spectatorSnapshot.view,
          game: {
            ...spectatorSnapshot.view.game,
            viewerHand: gameSnapshot.view.game.viewerHand,
          },
        },
      }),
    ).toThrow("private hand");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: { ...gameSnapshot.view, phase: "exhausted" },
      }),
    ).toThrow("phase");
  });

  it.each([
    ["hidden root field", { ...snapshot, hand: { tiles: [] } }],
    [
      "hidden occupant field",
      {
        ...snapshot,
        view: {
          ...snapshot.view,
          seats: [
            {
              seat: "east",
              occupant: {
                id: "mock:2",
                displayName: "East Player",
                concealedTiles: ["1m"],
              },
              ready: false,
            },
            ...snapshot.view.seats.slice(1),
          ],
        },
      },
    ],
    [
      "non-canonical seat order",
      {
        ...snapshot,
        view: {
          ...snapshot.view,
          seats: [
            snapshot.view.seats[1],
            snapshot.view.seats[0],
            ...snapshot.view.seats.slice(2),
          ],
        },
      },
    ],
    [
      "duplicate actor",
      {
        ...snapshot,
        view: {
          ...snapshot.view,
          spectators: [
            ...snapshot.view.spectators,
            snapshot.view.spectators[0],
          ],
        },
      },
    ],
  ])("rejects a projection with %s", (_name, value) => {
    expect(() => parseTableSnapshot(value)).toThrow();
  });

  it("rejects a spectator viewer carrying a seat", () => {
    expect(() =>
      parseTableSnapshot({
        ...snapshot,
        view: {
          ...snapshot.view,
          viewer: { ...snapshot.view.viewer, seat: "east" },
        },
      }),
    ).toThrow("viewer");
  });

  it("parses applied and rejected command receipts", () => {
    expect(
      parseTableReceipt({
        type: "table/receipt",
        protocolVersion: 1,
        commandId: "command-1",
        stateVersion: 2,
        outcome: "applied",
      }),
    ).toMatchObject({ commandId: "command-1", outcome: "applied" });
    expect(
      parseTableReceipt({
        type: "table/receipt",
        protocolVersion: 1,
        commandId: "command-2",
        stateVersion: 2,
        outcome: "rejected",
        error: { code: "stale-version", message: "Resync required." },
      }),
    ).toMatchObject({
      commandId: "command-2",
      outcome: "rejected",
      error: { code: "stale-version", message: "Resync required." },
    });
  });

  it("rejects non-canonical receipts", () => {
    expect(() =>
      parseTableReceipt({
        type: "table/receipt",
        protocolVersion: 1,
        commandId: "command-1",
        stateVersion: 2,
        outcome: "applied",
        error: { code: "impossible", message: "not allowed" },
      }),
    ).toThrow("outcome");
  });

  it("serializes strict lobby command envelopes", () => {
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket",
      () => socket as unknown as WebSocket,
    );
    monitor.start(() => undefined);
    socket.emit("open", new Event("open"));

    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 1,
      commandId: "claim-1",
      expectedStateVersion: 0,
      command: { type: "lobby/claim-seat", seat: "east" },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 1,
      commandId: "ready-1",
      expectedStateVersion: 1,
      command: { type: "lobby/set-ready", ready: true },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 1,
      commandId: "leave-1",
      expectedStateVersion: 2,
      command: { type: "lobby/leave-seat" },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 1,
      commandId: "discard-1",
      expectedStateVersion: 3,
      command: { type: "game/discard", tileId: 42 },
    });

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "table/command",
        protocolVersion: 1,
        commandId: "claim-1",
        expectedStateVersion: 0,
        command: { type: "lobby/claim-seat", seat: "east" },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 1,
        commandId: "ready-1",
        expectedStateVersion: 1,
        command: { type: "lobby/set-ready", ready: true },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 1,
        commandId: "leave-1",
        expectedStateVersion: 2,
        command: { type: "lobby/leave-seat" },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 1,
        commandId: "discard-1",
        expectedStateVersion: 3,
        command: { type: "game/discard", tileId: 42 },
      }),
    ]);
  });

  it("publishes receipts without treating them as protocol errors", () => {
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const statuses: Parameters<
      Parameters<ReconnectingSocketStatusMonitor["start"]>[0]
    >[0][] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket",
      () => socket as unknown as WebSocket,
    );
    monitor.start((status) => statuses.push(status));
    socket.emit("open", new Event("open"));
    socket.emit(
      "message",
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "table/receipt",
          protocolVersion: 1,
          commandId: "command-1",
          stateVersion: 1,
          outcome: "applied",
        }),
      }),
    );

    expect(statuses.at(-1)).toMatchObject({
      state: "connected",
      latestReceipt: { commandId: "command-1", outcome: "applied" },
    });
    expect(socket.closed).toBe(false);
  });

  it("requests a resync from the last snapshot after reconnecting", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket",
      () => sockets.shift() as unknown as WebSocket,
    );
    const stop = monitor.start((status) => states.push(status.state));

    first.emit("open", new Event("open"));
    first.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(snapshot) }),
    );
    first.emit("close", new Event("close"));
    vi.advanceTimersByTime(1_000);
    second.emit("open", new Event("open"));

    expect(second.sent).toEqual([
      JSON.stringify({
        type: "table/resync",
        protocolVersion: 1,
        lastSeenStateVersion: 0,
      }),
    ]);
    expect(states.at(-1)).toBe("reconnecting");
    expect(() => {
      monitor.sendCommand({
        type: "table/command",
        protocolVersion: 1,
        commandId: "stale-ui-command",
        expectedStateVersion: 0,
        command: { type: "lobby/leave-seat" },
      });
    }).toThrow("not connected");

    second.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(snapshot) }),
    );
    expect(states.at(-1)).toBe("connected");
    stop();
  });

  it("treats the session-replaced control frame as terminal", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket",
      createSocket,
    );
    monitor.start((status) => states.push(status.state));

    socket.emit("open", new Event("open"));
    socket.emit(
      "message",
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "session/replaced",
          protocolVersion: 1,
        }),
      }),
    );
    socket.emit("close", Object.assign(new Event("close"), { code: 4001 }));
    vi.advanceTimersByTime(30_000);

    expect(states.at(-1)).toBe("session-replaced");
    expect(socket.closeCode).toBe(4001);
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after a replacement close without a control frame", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket",
      createSocket,
    );
    monitor.start((status) => states.push(status.state));

    socket.emit("open", new Event("open"));
    socket.emit("close", Object.assign(new Event("close"), { code: 4001 }));
    vi.advanceTimersByTime(30_000);

    expect(states.at(-1)).toBe("session-replaced");
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after an authorization policy close", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket",
      createSocket,
    );
    monitor.start((status) => states.push(status.state));

    socket.emit("open", new Event("open"));
    socket.emit("close", Object.assign(new Event("close"), { code: 1008 }));
    vi.advanceTimersByTime(30_000);

    expect(states.at(-1)).toBe("authentication-required");
    expect(createSocket).toHaveBeenCalledTimes(1);
  });
});
