import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import type {
  TableCommandEnvelope,
  TableReceipt,
  TableSocketMessage,
  ViewerSafeTableSnapshot,
} from "./table-socket-protocol-v2.js";
import {
  ReconnectingSocketStatusMonitor,
  type SocketStatus,
} from "./table-socket-status.js";

const snapshot: ViewerSafeTableSnapshot = {
  type: "table/snapshot",
  protocolVersion: 2,
  stateVersion: 4,
  view: {
    phase: "lobby",
    tableId: "lifecycle-table",
    seats: (["east", "south", "west", "north"] as const).map((seat) => ({
      seat,
      occupant: null,
      autopilot: false,
      ready: false,
    })),
    spectators: [{ id: "mock:1", displayName: "Local Player" }],
    viewer: {
      role: "spectator",
      actor: { id: "mock:1", displayName: "Local Player" },
    },
  },
};

const receipt: TableReceipt = {
  type: "table/receipt",
  protocolVersion: 2,
  commandId: "reaction-1",
  stateVersion: 4,
  outcome: "applied",
};

const command: TableCommandEnvelope = {
  type: "table/command",
  protocolVersion: 2,
  commandId: "command-1",
  expectedStateVersion: 4,
  command: { type: "lobby/leave-seat" },
};

class LifecycleSocket {
  public readyState: number = WebSocket.CONNECTING;
  public readonly sent: string[] = [];
  public readonly close = vi.fn<(code?: number, reason?: string) => void>(
    (code) => {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException(
          "Invalid client close code",
          "InvalidAccessError",
        );
      }
      this.readyState = WebSocket.CLOSING;
    },
  );
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  public addEventListener(
    type: string,
    listener: (event: Event) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(
    type: string,
    listener: (event: Event) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(value: string): void {
    this.sent.push(value);
  }

  public emit(type: string, event: Event = new Event(type)): void {
    if (type === "open") this.readyState = WebSocket.OPEN;
    if (type === "close") this.readyState = WebSocket.CLOSED;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  public message(value: unknown): void {
    this.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  public disconnect(code = 1006): void {
    this.emit("close", Object.assign(new Event("close"), { code }));
  }

  public capture(type: string): (event: Event) => void {
    const listeners = [...(this.listeners.get(type) ?? [])];
    return (event) => {
      for (const listener of listeners) listener(event);
    };
  }
}

function setup() {
  const sockets: LifecycleSocket[] = [];
  const createSocket = vi.fn(() => {
    const socket = new LifecycleSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const monitor = new ReconnectingSocketStatusMonitor(
    "ws://activity.test/api/table/socket?protocolVersion=2",
    createSocket,
  );
  const statuses: SocketStatus[] = [];
  const currentSocket = (): LifecycleSocket => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("The monitor has not created a socket.");
    return socket;
  };
  return { createSocket, currentSocket, monitor, statuses };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("typed socket lifecycle and message delivery", () => {
  it("maps every subscription name to its exact wire payload", () => {
    const { monitor } = setup();
    monitor.subscribe("table/snapshot", (message) => {
      expectTypeOf(message).toEqualTypeOf<ViewerSafeTableSnapshot>();
    });
    monitor.subscribe("table/receipt", (message) => {
      expectTypeOf(message).toEqualTypeOf<TableReceipt>();
    });
    monitor.subscribe("session/replaced", (message) => {
      expectTypeOf(message).toEqualTypeOf<
        Extract<TableSocketMessage, { type: "session/replaced" }>
      >();
    });
    monitor.subscribe("table/upgrade-required", (message) => {
      expectTypeOf(message).toEqualTypeOf<
        Extract<TableSocketMessage, { type: "table/upgrade-required" }>
      >();
    });
    const typecheckInvalidSubscriptions = () => {
      // @ts-expect-error Unsupported event names are not wire messages.
      monitor.subscribe("table/unknown", () => undefined);
      const snapshotListener = (message: ViewerSafeTableSnapshot) => message;
      // @ts-expect-error A receipt subscription cannot receive snapshots.
      monitor.subscribe("table/receipt", snapshotListener);
    };
    expectTypeOf(typecheckInvalidSubscriptions).toEqualTypeOf<() => void>();
  });

  it("requires a fresh snapshot on initial open and on reconnect before enabling commands", () => {
    const { monitor, currentSocket, statuses, createSocket } = setup();
    const duringSnapshot: boolean[] = [];
    monitor.subscribe("table/snapshot", () => {
      try {
        monitor.sendCommand(command);
        duringSnapshot.push(true);
      } catch {
        duringSnapshot.push(false);
      }
    });
    const stop = monitor.start((status) => statuses.push(status));
    expect(statuses).toEqual([{ state: "connecting", attempt: 1 }]);
    expect(() => {
      monitor.sendCommand(command);
    }).toThrow();
    const first = currentSocket();
    first.emit("open");
    expect(statuses.at(-1)).toMatchObject({ state: "awaiting-snapshot" });
    expect(first.sent).toEqual([
      JSON.stringify({
        type: "table/resync",
        protocolVersion: 2,
        lastSeenStateVersion: 0,
      }),
    ]);
    expect(() => {
      monitor.sendCommand(command);
    }).toThrow();
    first.message(receipt);
    expect(statuses.at(-1)?.state).toBe("awaiting-snapshot");
    first.message(snapshot);
    expect(statuses.at(-1)).toEqual({ state: "connected" });
    monitor.sendCommand(command);
    first.message({ ...receipt, stateVersion: 5 });
    first.disconnect();
    expect(() => {
      monitor.sendCommand(command);
    }).toThrow();
    vi.advanceTimersByTime(1_000);
    const second = currentSocket();
    second.emit("open");
    expect(statuses.at(-1)?.state).toBe("awaiting-snapshot");
    expect(second.sent).toEqual([
      JSON.stringify({
        type: "table/resync",
        protocolVersion: 2,
        lastSeenStateVersion: 4,
      }),
    ]);
    expect(() => {
      monitor.sendCommand(command);
    }).toThrow();
    second.message(snapshot);
    expect(duringSnapshot).toEqual([false, false]);
    expect(statuses.at(-1)).toEqual({ state: "connected" });
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(second.sent).toHaveLength(1);
    monitor.sendCommand(command);
    expect(second.sent.at(-1)).toBe(JSON.stringify(command));
    stop();
  });

  it("finishes snapshot delivery before connected and preserves private receipt ordering", () => {
    const { monitor, currentSocket } = setup();
    const events: string[] = [];
    monitor.subscribe("table/snapshot", (message) =>
      events.push(`snapshot:${String(message.stateVersion)}`),
    );
    monitor.subscribe("table/receipt", (message) =>
      events.push(`receipt:${message.commandId}`),
    );
    const stop = monitor.start((status) => events.push(status.state));
    const socket = currentSocket();
    socket.emit("open");
    events.length = 0;
    socket.message(snapshot);
    socket.message(receipt);
    socket.message({ ...snapshot, stateVersion: 4 });
    socket.message({ ...receipt, commandId: "reaction-2" });
    socket.message({ ...snapshot, stateVersion: 5 });
    expect(events).toEqual([
      "snapshot:4",
      "connected",
      "receipt:reaction-1",
      "snapshot:4",
      "receipt:reaction-2",
      "snapshot:5",
    ]);
    stop();
  });

  it("decodes each inbound frame once and shares its validated payload with subscribers", () => {
    const { monitor, currentSocket } = setup();
    const messages: ViewerSafeTableSnapshot[] = [];
    monitor.subscribe("table/snapshot", (message) => messages.push(message));
    monitor.subscribe("table/snapshot", (message) => messages.push(message));
    const stop = monitor.start(() => undefined);
    currentSocket().emit("open");
    const parse = vi.spyOn(JSON, "parse");
    currentSocket().message(snapshot);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([snapshot, snapshot]);
    expect(messages[0]).toBe(messages[1]);
    stop();
  });

  it("isolates throwing lifecycle and message callbacks from wire validation and other subscribers", () => {
    const { monitor, currentSocket, statuses } = setup();
    const received: TableSocketMessage[] = [];
    monitor.subscribe("table/snapshot", () => {
      throw new Error("Snapshot consumer failed");
    });
    monitor.subscribe("table/snapshot", (message) => received.push(message));
    monitor.subscribe("table/receipt", () => {
      throw new Error("Receipt consumer failed");
    });
    monitor.subscribe("table/receipt", (message) => received.push(message));
    const stop = monitor.start((status) => {
      statuses.push(status);
      throw new Error("Lifecycle consumer failed");
    });
    const socket = currentSocket();
    socket.emit("open");
    socket.message(snapshot);
    socket.message(receipt);
    expect(received).toEqual([snapshot, receipt]);
    expect(statuses.at(-1)).toEqual({ state: "connected" });
    expect(socket.close).not.toHaveBeenCalled();
    expect(() => {
      monitor.sendCommand(command);
    }).not.toThrow();
    expect(stop).not.toThrow();
    expect(statuses.at(-1)).toEqual({ state: "stopped" });
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("queues reentrant socket events until all subscribers finish the current message", () => {
    const { monitor, currentSocket } = setup();
    const events: string[] = [];
    monitor.subscribe("table/snapshot", (message) => {
      events.push(`first:${String(message.stateVersion)}`);
      if (message.stateVersion === 4) currentSocket().message(receipt);
    });
    monitor.subscribe("table/snapshot", () => events.push("second"));
    monitor.subscribe("table/receipt", () => {
      events.push("receipt");
      currentSocket().message({ ...snapshot, stateVersion: 5 });
    });
    const stop = monitor.start((status) => events.push(status.state));
    currentSocket().emit("open");
    events.length = 0;
    currentSocket().message(snapshot);
    expect(events).toEqual([
      "first:4",
      "second",
      "connected",
      "receipt",
      "first:5",
      "second",
    ]);
    stop();
  });

  it("skips subscriptions removed during delivery and retains other subscriptions across restarts", () => {
    const { monitor, currentSocket } = setup();
    const events: string[] = [];
    monitor.subscribe("table/snapshot", () => {
      events.push("first");
      unsubscribe();
    });
    const unsubscribe = monitor.subscribe("table/snapshot", () =>
      events.push("removed"),
    );
    const stop = monitor.start(() => undefined);
    currentSocket().emit("open");
    currentSocket().message(snapshot);
    stop();
    const stopAgain = monitor.start(() => undefined);
    currentSocket().emit("open");
    currentSocket().message(snapshot);
    unsubscribe();
    expect(events).toEqual(["first", "first"]);
    stopAgain();
  });

  it("stops immediately from a subscriber without delivering queued messages or enabling commands", () => {
    const { monitor, currentSocket, statuses, createSocket } = setup();
    const received = vi.fn();
    monitor.subscribe("table/snapshot", () => {
      currentSocket().message(receipt);
      stop();
    });
    monitor.subscribe("table/snapshot", received);
    monitor.subscribe("table/receipt", received);
    const stop = monitor.start((status) => statuses.push(status));
    currentSocket().emit("open");
    currentSocket().message(snapshot);
    vi.runAllTimers();
    expect(received).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ state: "stopped" });
    expect(statuses.some(({ state }) => state === "connected")).toBe(false);
    expect(() => {
      monitor.sendCommand(command);
    }).toThrow();
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it("ignores old stop handles and captured callbacks after a subscriber starts a new run", () => {
    const { monitor, currentSocket, statuses, createSocket } = setup();
    const received: number[] = [];
    let restart = true;
    monitor.subscribe("table/snapshot", () => {
      if (restart) {
        restart = false;
        monitor.start((status) => statuses.push(status));
      }
    });
    monitor.subscribe("table/snapshot", (message) =>
      received.push(message.stateVersion),
    );
    const oldStop = monitor.start((status) => statuses.push(status));
    const first = currentSocket();
    const staleOpen = first.capture("open");
    const staleMessage = first.capture("message");
    const staleError = first.capture("error");
    const staleClose = first.capture("close");
    first.emit("open");
    first.message(snapshot);
    const second = currentSocket();
    expect(second).not.toBe(first);
    oldStop();
    staleOpen(new Event("open"));
    staleMessage(
      new MessageEvent("message", { data: "invalid obsolete data" }),
    );
    staleError(new Event("error"));
    staleClose(Object.assign(new Event("close"), { code: 1008 }));
    expect(received).toEqual([]);
    expect(second.close).not.toHaveBeenCalled();
    second.emit("open");
    second.message({ ...snapshot, stateVersion: 5 });
    vi.runAllTimers();
    expect(received).toEqual([5]);
    expect(statuses.at(-1)).toEqual({ state: "connected" });
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(() => {
      monitor.sendCommand(command);
    }).not.toThrow();
  });

  it("cancels a pending retry on stop and initializes an explicit restart from a fresh cursor", () => {
    const { monitor, currentSocket, createSocket } = setup();
    const stop = monitor.start(() => undefined);
    currentSocket().emit("open");
    currentSocket().message(snapshot);
    currentSocket().disconnect();
    stop();
    vi.runAllTimers();
    expect(createSocket).toHaveBeenCalledTimes(1);
    const stopAgain = monitor.start(() => undefined);
    currentSocket().emit("open");
    expect(currentSocket().sent).toEqual([
      JSON.stringify({
        type: "table/resync",
        protocolVersion: 2,
        lastSeenStateVersion: 0,
      }),
    ]);
    expect(() => {
      monitor.sendCommand(command);
    }).toThrow();
    stopAgain();
  });

  it("allows restarting from a stopped callback without notifying the retired callback twice", () => {
    const { monitor, currentSocket, statuses, createSocket } = setup();
    let stopNotices = 0;
    const stop = monitor.start((status) => {
      if (status.state === "stopped") {
        stopNotices += 1;
        if (stopNotices === 1)
          monitor.start((nextStatus) => statuses.push(nextStatus));
      }
    });
    const first = currentSocket();
    stop();
    expect(stopNotices).toBe(1);
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    const second = currentSocket();
    stop();
    expect(second.close).not.toHaveBeenCalled();
    second.emit("open");
    second.message(snapshot);
    expect(statuses.at(-1)).toEqual({ state: "connected" });
  });

  it("creates only the replacement socket when a connecting callback starts another run", () => {
    const { monitor, currentSocket, statuses, createSocket } = setup();
    const originalStates: string[] = [];
    const stopOriginal = monitor.start((status) => {
      originalStates.push(status.state);
      if (status.state === "connecting")
        monitor.start((nextStatus) => statuses.push(nextStatus));
    });
    expect(originalStates).toEqual(["connecting", "stopped"]);
    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([{ state: "connecting", attempt: 1 }]);
    stopOriginal();
    expect(currentSocket().close).not.toHaveBeenCalled();
    currentSocket().emit("open");
    currentSocket().message(snapshot);
    expect(statuses.at(-1)).toEqual({ state: "connected" });
  });

  it.each(["stop", "restart"] as const)(
    "skips the obsolete resync when an awaiting-snapshot callback requests %s",
    (action) => {
      const { monitor, currentSocket, statuses, createSocket } = setup();
      let stopReplacement: (() => void) | undefined;
      const stop = monitor.start((status) => {
        statuses.push(status);
        if (status.state !== "awaiting-snapshot") return;
        if (action === "stop") {
          stop();
        } else {
          stopReplacement = monitor.start((next) => statuses.push(next));
        }
      });
      const first = currentSocket();
      first.emit("open");
      expect(first.sent).toEqual([]);
      expect(first.close).toHaveBeenCalledOnce();
      expect(statuses.some(({ state }) => state === "connected")).toBe(false);
      expect(() => {
        monitor.sendCommand(command);
      }).toThrow();
      vi.runAllTimers();

      if (action === "stop") {
        expect(statuses.at(-1)).toEqual({ state: "stopped" });
        expect(createSocket).toHaveBeenCalledTimes(1);
        return;
      }

      const replacement = currentSocket();
      expect(replacement).not.toBe(first);
      expect(createSocket).toHaveBeenCalledTimes(2);
      stop();
      expect(replacement.close).not.toHaveBeenCalled();
      replacement.emit("open");
      expect(replacement.sent).toEqual([
        JSON.stringify({
          type: "table/resync",
          protocolVersion: 2,
          lastSeenStateVersion: 0,
        }),
      ]);
      expect(() => {
        monitor.sendCommand(command);
      }).toThrow();
      replacement.message(snapshot);
      expect(statuses.at(-1)).toEqual({ state: "connected" });
      stopReplacement?.();
    },
  );

  it.each([
    {
      type: "session/replaced",
      protocolVersion: 2,
      state: "session-replaced",
    },
    {
      type: "table/upgrade-required",
      protocolVersion: 2,
      minimumSupportedVersion: 2,
      state: "upgrade-required",
    },
  ] as const)(
    "suppresses obsolete $type delivery when its terminal callback restarts",
    ({ state, ...control }) => {
      const { monitor, currentSocket, statuses, createSocket } = setup();
      const receiveControl = vi.fn();
      monitor.subscribe(control.type, receiveControl);
      let stopReplacement: (() => void) | undefined;
      const stop = monitor.start((status) => {
        if (status.state === state) {
          stopReplacement = monitor.start((next) => statuses.push(next));
        }
      });
      const first = currentSocket();
      first.emit("open");
      first.message(snapshot);
      first.message(control);

      const replacement = currentSocket();
      expect(replacement).not.toBe(first);
      expect(first.close).toHaveBeenCalledOnce();
      expect(receiveControl).not.toHaveBeenCalled();
      expect(statuses).toEqual([{ state: "connecting", attempt: 1 }]);
      stop();
      expect(replacement.close).not.toHaveBeenCalled();
      replacement.emit("open");
      expect(() => {
        monitor.sendCommand(command);
      }).toThrow();
      replacement.message(snapshot);
      expect(statuses.at(-1)).toEqual({ state: "connected" });
      expect(createSocket).toHaveBeenCalledTimes(2);
      stopReplacement?.();
    },
  );

  it.each([
    {
      type: "session/replaced",
      protocolVersion: 2,
      state: "session-replaced",
      code: 4001,
    },
    {
      type: "table/upgrade-required",
      protocolVersion: 2,
      minimumSupportedVersion: 2,
      state: "upgrade-required",
      code: 4406,
    },
  ] as const)(
    "cleans up before delivering $type even when consumers throw",
    ({ state, code, ...control }) => {
      const { monitor, currentSocket, statuses, createSocket } = setup();
      const events: string[] = [];
      let stateDuringControl: SocketStatus | undefined;
      let closedDuringControl = false;
      let commandBlockedDuringControl = false;
      monitor.subscribe(control.type, () => {
        events.push("first-control");
        throw new Error("Control consumer failed");
      });
      monitor.subscribe(control.type, (message) => {
        events.push(message.type);
        stateDuringControl = statuses.at(-1);
        closedDuringControl = currentSocket().close.mock.calls.some(
          ([closeCode]) => closeCode === code,
        );
        try {
          monitor.sendCommand(command);
        } catch {
          commandBlockedDuringControl = true;
        }
      });
      monitor.start((status) => {
        statuses.push(status);
        events.push(status.state);
        if (status.state === state)
          throw new Error("Terminal lifecycle consumer failed");
      });
      const socket = currentSocket();
      socket.emit("open");
      socket.message(snapshot);
      events.length = 0;
      socket.message(control);
      socket.message(snapshot);
      socket.emit("error");
      socket.disconnect();
      vi.runAllTimers();
      expect(events).toEqual([state, "first-control", control.type]);
      expect(stateDuringControl).toEqual({ state });
      expect(closedDuringControl).toBe(true);
      expect(commandBlockedDuringControl).toBe(true);
      expect(statuses.at(-1)).toEqual({ state });
      expect(createSocket).toHaveBeenCalledTimes(1);
      expect(socket.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [1008, "authentication-required"],
    [4001, "session-replaced"],
    [4406, "upgrade-required"],
  ] as const)(
    "treats close code %s as terminal without synthesizing messages",
    (code, state) => {
      const { monitor, currentSocket, statuses, createSocket } = setup();
      const listener = vi.fn();
      monitor.subscribe("session/replaced", listener);
      monitor.subscribe("table/upgrade-required", listener);
      monitor.start((status) => statuses.push(status));
      const socket = currentSocket();
      socket.emit("open");
      socket.message(snapshot);
      socket.disconnect(code);
      socket.message(snapshot);
      vi.runAllTimers();
      expect(statuses.at(-1)).toEqual({ state });
      expect(listener).not.toHaveBeenCalled();
      expect(createSocket).toHaveBeenCalledTimes(1);
      expect(() => {
        monitor.sendCommand(command);
      }).toThrow();
    },
  );

  it.each([
    [1008, "authentication-required"],
    [4001, "session-replaced"],
    [4406, "upgrade-required"],
  ] as const)(
    "rejects sends while native closing preserves terminal close %s",
    (code, state) => {
      const { monitor, currentSocket, statuses, createSocket } = setup();
      monitor.start((status) => statuses.push(status));
      const socket = currentSocket();
      socket.emit("open");
      socket.message(snapshot);
      expect(statuses.at(-1)).toEqual({ state: "connected" });
      socket.sent.length = 0;

      // Native CLOSING becomes visible before the close event is delivered.
      socket.readyState = WebSocket.CLOSING;
      expect(() => {
        monitor.sendCommand(command);
      }).toThrow();
      expect(statuses.at(-1)?.state).toBe("disconnecting");
      expect(socket.sent).toEqual([]);
      expect(socket.close).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(createSocket).toHaveBeenCalledTimes(1);

      socket.disconnect(code);
      expect(statuses.at(-1)).toEqual({ state });
      expect(() => {
        monitor.sendCommand(command);
      }).toThrow();
      vi.runAllTimers();
      expect(socket.sent).toEqual([]);
      expect(createSocket).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [1008, "authentication-required"],
    [4001, "session-replaced"],
    [4406, "upgrade-required"],
  ] as const)(
    "blocks sends after error while preserving terminal close %s",
    (code, state) => {
      const { monitor, currentSocket, statuses, createSocket } = setup();
      monitor.start((status) => statuses.push(status));
      const socket = currentSocket();
      socket.emit("open");
      socket.message(snapshot);
      socket.emit("error");
      expect(statuses.at(-1)?.state).toBe("disconnecting");
      expect(() => {
        monitor.sendCommand(command);
      }).toThrow();
      expect(socket.close).not.toHaveBeenCalled();
      socket.disconnect(code);
      vi.runAllTimers();
      expect(statuses.at(-1)).toEqual({ state });
      expect(createSocket).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed wire data terminally without delivering application messages", () => {
    const { monitor, currentSocket, statuses, createSocket } = setup();
    const received = vi.fn();
    monitor.subscribe("table/snapshot", received);
    monitor.start((status) => statuses.push(status));
    const socket = currentSocket();
    socket.emit("open");
    socket.message({ ...snapshot, forbidden: "unexpected field" });
    socket.message(snapshot);
    socket.disconnect();
    vi.runAllTimers();
    expect(statuses.at(-1)).toEqual({ state: "protocol-error" });
    expect(socket.close.mock.calls.map(([code]) => code)).toEqual([1000]);
    expect(received).not.toHaveBeenCalled();
    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(() => {
      monitor.sendCommand(command);
    }).toThrow();
  });
});
