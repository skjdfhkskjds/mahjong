import { describe, expect, it, vi } from "vitest";

import type { DiscordBridge } from "../../adapters/discord/discord-bridge.js";
import type { ActivityApi } from "../../adapters/transport/activity-api-client.js";
import type { SocketStatusMonitor } from "../../adapters/transport/table-socket-status.js";
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
        mode: "mock",
        actor: { id: "server-id", displayName: "Local Player" },
        expiresAt: "2026-08-23T13:00:00.000Z",
        csrfToken: "csrf-value",
      }),
    exchangeDiscordCode: () =>
      Promise.reject(new Error("Not used in mock mode.")),
    getSession: () =>
      Promise.resolve({
        authenticated: true,
        mode: "mock",
        actor: { id: "server-id", displayName: "Local Player" },
        expiresAt: "2026-08-23T13:00:00.000Z",
        csrfToken: "csrf-value",
      }),
    ...overrides,
  };
}

function connectedSocket(): SocketStatusMonitor {
  return {
    start: (onStatus) => {
      onStatus({
        state: "connected",
        attempt: 0,
        snapshot: {
          type: "table/snapshot",
          protocolVersion: 1,
          stateVersion: 0,
          view: {
            phase: "lobby",
            tableId: "walking-skeleton",
            viewer: {
              role: "spectator",
              actor: { id: "server-id", displayName: "Local Player" },
            },
          },
        },
      });
      return vi.fn();
    },
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

describe("client startup", () => {
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
            mode: "mock",
            actor: { id: "different-id", displayName: "Someone Else" },
            expiresAt: "2026-08-23T13:00:00.000Z",
            csrfToken: "csrf-value",
          }),
      }),
      socket: { start: startSocket },
      onStatus: (status) => statuses.push(status),
    });

    await flushPromises();

    expect(startSocket).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.session).toMatchObject({ state: "failed" });
  });
});
