import { afterEach, describe, expect, it, vi } from "vitest";

import {
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

  public close(): void {
    this.closed = true;
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
});
