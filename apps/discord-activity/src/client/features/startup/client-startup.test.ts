import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscordBridge } from "../../adapters/discord/discord-bridge.js";
import type { ActivityApi } from "../../adapters/transport/activity-api-client.js";
import {
  ReconnectingSocketStatusMonitor,
  type SocketStatusMonitor,
  type TableReceipt,
  type ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";
import type { RuntimeConfig } from "../../bootstrap/runtime-config.js";
import {
  startClientStartup,
  type ClientStartupStatus,
} from "./client-startup.js";

const config: RuntimeConfig = {
  mode: "mock",
  apiBaseUrl: "",
  mockActor: { id: "local-id", displayName: "Local Player" },
};

const bridge: DiscordBridge = {
  mode: "mock",
  initialize: () => Promise.resolve({ instanceId: "instance-1" }),
  authorize: () => Promise.resolve(undefined),
  authenticate: () =>
    Promise.resolve({ id: "server-id", displayName: "Local Player" }),
};

const tableId = "dGVzdC10YWJsZS1pZC0xNg";

function createApi(overrides: Partial<ActivityApi> = {}): ActivityApi {
  return {
    getHealth: () =>
      Promise.resolve({
        status: "ok",
        mode: "mock",
        now: "2026-08-23T12:00:00.000Z",
      }),
    createMockSession: () =>
      Promise.resolve({
        authenticated: true,
        access: "member",
        role: "owner",
        mode: "mock",
        actor: { id: "server-id", displayName: "Local Player" },
        expiresAt: "2026-08-23T13:00:00.000Z",
        csrfToken: "csrf-value",
        instanceId: "instance-1",
        tableId,
      }),
    exchangeDiscordCode: () =>
      Promise.reject(new Error("Not used in mock mode.")),
    getSession: () =>
      Promise.resolve({
        authenticated: true,
        access: "member",
        role: "owner",
        mode: "mock",
        actor: { id: "server-id", displayName: "Local Player" },
        expiresAt: "2026-08-23T13:00:00.000Z",
        csrfToken: "csrf-value",
        instanceId: "instance-1",
        tableId,
      }),
    createInvitation: () =>
      Promise.resolve({ capability: "invitation", expiresAt: Date.now() }),
    redeemInvitation: () => Promise.resolve({ role: "member", tableId }),
    createResumeCapability: () =>
      Promise.resolve({ capability: "resume", expiresAt: Date.now() }),
    logout: () => Promise.resolve(),
    ...overrides,
  };
}

function connectedSnapshot(): ViewerSafeTableSnapshot {
  return {
    type: "table/snapshot",
    protocolVersion: 2,
    stateVersion: 0,
    view: {
      phase: "lobby",
      tableId: "walking-skeleton",
      seats: [
        { seat: "east", occupant: null, autopilot: false, ready: false },
        { seat: "south", occupant: null, autopilot: false, ready: false },
        { seat: "west", occupant: null, autopilot: false, ready: false },
        { seat: "north", occupant: null, autopilot: false, ready: false },
      ],
      spectators: [{ id: "server-id", displayName: "Local Player" }],
      viewer: {
        role: "spectator",
        actor: { id: "server-id", displayName: "Local Player" },
      },
    },
  };
}

class TestSocket extends EventTarget {
  public readyState: number = WebSocket.CONNECTING;
  public readonly send = vi.fn();
  public readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSING;
  });

  public open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  public message(value: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }

  public disconnect(code = 1006): void {
    this.readyState = WebSocket.CLOSED;
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }
}

function socketHarness() {
  const connections: TestSocket[] = [];
  const monitor = new ReconnectingSocketStatusMonitor(
    "ws://localhost/table",
    () => {
      const connection = new TestSocket();
      connections.push(connection);
      return connection as unknown as WebSocket;
    },
  );
  return {
    monitor,
    connections,
    current: (): TestSocket => {
      const connection = connections.at(-1);
      if (!connection) throw new Error("No connection was created.");
      return connection;
    },
  };
}

function connectedSocket(): SocketStatusMonitor {
  const harness = socketHarness();
  return {
    subscribe: (type, listener) => harness.monitor.subscribe(type, listener),
    start: (onStatus) => {
      const stop = harness.monitor.start(onStatus);
      harness.current().open();
      harness.current().message(connectedSnapshot());
      return stop;
    },
  };
}

const receipt: TableReceipt = {
  type: "table/receipt",
  protocolVersion: 2,
  commandId: "private-reaction",
  stateVersion: 0,
  outcome: "applied",
};

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

describe("client startup", () => {
  afterEach(() => vi.useRealTimers());
  it("establishes a server-assigned mock session before opening the socket", async () => {
    const statuses: ClientStartupStatus[] = [];
    const stop = startClientStartup({
      config,
      bridge,
      api: createApi(),
      socket: connectedSocket(),
      onStatus: (status) => statuses.push(status),
    });

    await flushPromises();

    expect(statuses.at(-1)).toMatchObject({
      complete: true,
      actor: { id: "server-id", displayName: "Local Player" },
      activity: { state: "ready" },
      health: { state: "ready" },
      session: { state: "ready" },
      socket: { state: "ready" },
    });
    stop();
  });

  it("does not open a socket when the session actor mismatches", async () => {
    const startSocket = vi.fn();
    const statuses: ClientStartupStatus[] = [];

    startClientStartup({
      config,
      bridge,
      api: createApi({
        getSession: () =>
          Promise.resolve({
            authenticated: true,
            access: "member",
            role: "member",
            mode: "mock",
            actor: { id: "different-id", displayName: "Someone Else" },
            expiresAt: "2026-08-23T13:00:00.000Z",
            csrfToken: "csrf-value",
            instanceId: "instance-1",
            tableId,
          }),
      }),
      socket: { start: startSocket, subscribe: vi.fn(() => vi.fn()) },
      onStatus: (status) => statuses.push(status),
    });

    await flushPromises();

    expect(startSocket).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.session).toMatchObject({ state: "failed" });
  });

  it("keeps join-required sessions stable without opening a socket", async () => {
    const startSocket = vi.fn();
    const statuses: ClientStartupStatus[] = [];

    startClientStartup({
      config,
      bridge,
      api: createApi({
        getSession: () =>
          Promise.resolve({
            authenticated: true,
            access: "join-required",
            mode: "mock",
            actor: { id: "server-id", displayName: "Local Player" },
            expiresAt: "2026-08-23T13:00:00.000Z",
            csrfToken: "csrf-value",
            instanceId: "instance-1",
            tableId,
          }),
      }),
      socket: { start: startSocket, subscribe: vi.fn(() => vi.fn()) },
      onStatus: (status) => statuses.push(status),
    });

    await flushPromises();

    expect(startSocket).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({
      complete: false,
      sessionResponse: { access: "join-required", tableId },
      session: { state: "ready" },
      socket: { state: "waiting" },
    });
  });

  it.each([
    {
      state: "session-replaced",
      input: { type: "session/replaced", protocolVersion: 2 },
      sessionFailed: true,
    },
    {
      state: "upgrade-required",
      input: {
        type: "table/upgrade-required",
        protocolVersion: 2,
        minimumSupportedVersion: 2,
      },
      sessionFailed: true,
    },
    { state: "protocol-error", input: { invalid: true }, sessionFailed: false },
    { state: "authentication-required", input: undefined, sessionFailed: true },
  ])(
    "clears application state on $state",
    async ({ state, input, sessionFailed }) => {
      const statuses: ClientStartupStatus[] = [];
      const harness = socketHarness();
      const stop = startClientStartup({
        config,
        bridge,
        api: createApi(),
        socket: harness.monitor,
        onStatus: (status) => statuses.push(status),
      });
      await flushPromises();
      harness.current().open();
      harness.current().message(connectedSnapshot());
      harness.current().message(receipt);
      expect(statuses.at(-1)?.complete).toBe(true);

      if (input) harness.current().message(input);
      else harness.current().disconnect(1008);

      expect(statuses.at(-1)).toMatchObject({
        complete: false,
        session: { state: sessionFailed ? "failed" : "ready" },
        socket: { state: "failed" },
        tableSnapshot: undefined,
        latestReceipt: undefined,
      });
      if (state === "upgrade-required") {
        expect(statuses.at(-1)?.socket.detail).toContain("protocol v2");
        expect(statuses.at(-1)?.session.detail).toContain("protocol v2");
      }
      stop();
    },
  );

  it("requires a fresh snapshot before becoming usable on initial and reopened connections", async () => {
    vi.useFakeTimers();
    const statuses: ClientStartupStatus[] = [];
    const harness = socketHarness();
    const stop = startClientStartup({
      config,
      bridge,
      api: createApi(),
      socket: harness.monitor,
      onStatus: (status) => statuses.push(status),
    });
    await flushPromises();
    const first = harness.current();
    first.open();
    expect(statuses.at(-1)).toMatchObject({
      complete: false,
      socket: { state: "working" },
      tableSnapshot: undefined,
    });
    first.message(connectedSnapshot());
    expect(statuses.at(-2)).toMatchObject({
      complete: false,
      tableSnapshot: connectedSnapshot(),
    });
    expect(statuses.at(-1)).toMatchObject({
      complete: true,
      tableSnapshot: connectedSnapshot(),
    });
    first.message(receipt);
    first.disconnect();
    expect(statuses.at(-1)).toMatchObject({
      complete: false,
      tableSnapshot: undefined,
      latestReceipt: undefined,
    });

    vi.advanceTimersByTime(1000);
    const reopened = harness.current();
    expect(reopened).not.toBe(first);
    reopened.open();
    expect(statuses.at(-1)).toMatchObject({
      complete: false,
      tableSnapshot: undefined,
    });
    const fresh = { ...connectedSnapshot(), stateVersion: 3 };
    reopened.message(fresh);
    expect(statuses.at(-1)).toMatchObject({
      complete: true,
      tableSnapshot: fresh,
      latestReceipt: undefined,
    });
    stop();
  });

  it("publishes receipts and snapshots in arrival order even at the same public revision", async () => {
    const statuses: ClientStartupStatus[] = [];
    const harness = socketHarness();
    const stop = startClientStartup({
      config,
      bridge,
      api: createApi(),
      socket: harness.monitor,
      onStatus: (status) => statuses.push(status),
    });
    await flushPromises();
    harness.current().open();
    harness.current().message(connectedSnapshot());
    statuses.length = 0;
    harness.current().message(receipt);
    const fresh = {
      ...connectedSnapshot(),
      view: { ...connectedSnapshot().view, tableId: "fresh-table" },
    };
    harness.current().message(fresh);
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({
      latestReceipt: receipt,
      tableSnapshot: connectedSnapshot(),
    });
    expect(statuses[1]).toMatchObject({
      latestReceipt: receipt,
      tableSnapshot: fresh,
      complete: true,
    });
    stop();
  });

  it("clears application state when the transport is explicitly stopped", async () => {
    const statuses: ClientStartupStatus[] = [];
    const harness = socketHarness();
    let stopTransport: () => void = vi.fn();
    const stop = startClientStartup({
      config,
      bridge,
      api: createApi(),
      socket: {
        subscribe: (type, listener) =>
          harness.monitor.subscribe(type, listener),
        start: (listener) => {
          stopTransport = harness.monitor.start(listener);
          return stopTransport;
        },
      },
      onStatus: (status) => statuses.push(status),
    });
    await flushPromises();
    harness.current().open();
    harness.current().message(connectedSnapshot());
    harness.current().message(receipt);
    stopTransport();
    expect(statuses.at(-1)).toMatchObject({
      complete: false,
      socket: { state: "warning" },
      tableSnapshot: undefined,
      latestReceipt: undefined,
    });
    stop();
  });

  it("clears application controls without reconnecting after an explicit departure close", async () => {
    vi.useFakeTimers();
    const statuses: ClientStartupStatus[] = [];
    const harness = socketHarness();
    const stop = startClientStartup({
      config,
      bridge,
      api: createApi(),
      socket: harness.monitor,
      onStatus: (status) => statuses.push(status),
    });
    await flushPromises();
    harness.current().open();
    harness.current().message(connectedSnapshot());
    harness.current().message(receipt);
    harness.current().disconnect(4002);
    vi.runAllTimers();
    expect(harness.connections).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({
      complete: false,
      tableSnapshot: undefined,
      latestReceipt: undefined,
      socket: { state: "warning" },
      session: { state: "ready" },
    });
    stop();
  });

  it("unsubscribes on disposal and ignores later messages from a restarted monitor", async () => {
    const statuses: ClientStartupStatus[] = [];
    const harness = socketHarness();
    const unsubscribeSnapshot = vi.fn();
    const unsubscribeReceipt = vi.fn();
    const cleanupListeners = [unsubscribeSnapshot, unsubscribeReceipt];
    const monitor: SocketStatusMonitor = {
      start: (listener) => harness.monitor.start(listener),
      subscribe: (type, listener) => {
        const unsubscribe = harness.monitor.subscribe(type, listener);
        const trackCleanup = cleanupListeners.shift();
        return () => {
          trackCleanup?.();
          unsubscribe();
        };
      },
    };
    const stop = startClientStartup({
      config,
      bridge,
      api: createApi(),
      socket: monitor,
      onStatus: (status) => statuses.push(status),
    });
    await flushPromises();
    expect(cleanupListeners).toHaveLength(0);
    stop();
    expect(unsubscribeSnapshot).toHaveBeenCalledOnce();
    expect(unsubscribeReceipt).toHaveBeenCalledOnce();
    const statusCount = statuses.length;
    const stopRestart = harness.monitor.start(vi.fn());
    harness.current().open();
    harness.current().message(connectedSnapshot());
    harness.current().message(receipt);
    expect(statuses).toHaveLength(statusCount);
    stopRestart();
  });

  it("does not start a late socket when disposed while session lookup is pending", async () => {
    const statuses: ClientStartupStatus[] = [];
    const api = createApi();
    const session = await api.getSession(new AbortController().signal);
    let resolveSession: ((value: typeof session) => void) | undefined;
    const harness = socketHarness();
    const stop = startClientStartup({
      config,
      bridge,
      api: {
        ...api,
        getSession: () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      },
      socket: harness.monitor,
      onStatus: (status) => statuses.push(status),
    });
    await flushPromises();
    expect(resolveSession).toBeDefined();
    stop();
    const count = statuses.length;
    resolveSession?.(session);
    await flushPromises();
    expect(harness.connections).toHaveLength(0);
    expect(statuses).toHaveLength(count);
  });

  it("retires a socket when disposed by its synchronous lifecycle callback", async () => {
    const harness = socketHarness();
    let stop: () => void = vi.fn();
    stop = startClientStartup({
      config,
      bridge,
      api: createApi(),
      socket: harness.monitor,
      onStatus: (status) => {
        if (status.socket.detail === "Connecting to the table coordinator.")
          stop();
      },
    });
    await flushPromises();
    expect(harness.current().close).toHaveBeenCalled();
  });
});
