import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTableSocketUrl,
  parseTableSnapshot,
  ReconnectingSocketStatusMonitor,
} from "./table-socket-status.js";

const snapshot = {
  type: "table/snapshot",
  protocolVersion: 1,
  stateVersion: 0,
  view: {
    phase: "lobby",
    seats: [],
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
        view: { phase: "lobby", tableId: "walking-skeleton" },
      }),
    ).toThrow("viewer");
  });

  it("rejects an unsupported protocol version", () => {
    expect(() =>
      parseTableSnapshot({ ...snapshot, protocolVersion: 2 }),
    ).toThrow("version");
  });

  it("requests a resync from the last snapshot after reconnecting", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket",
      () => sockets.shift() as unknown as WebSocket,
    );
    const stop = monitor.start(() => undefined);

    first.emit("open", new Event("open"));
    first.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(snapshot) }),
    );
    first.emit("close", new Event("close"));
    vi.advanceTimersByTime(1_000);
    second.emit("open", new Event("open"));

    expect(second.sent).toEqual([
      JSON.stringify({ type: "table/resync", lastSeenStateVersion: 0 }),
    ]);
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
