import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const origin = "https://activity.example";
const tableId = "public-boundary-test";

interface SnapshotMessage {
  readonly protocolVersion: 1;
  readonly stateVersion: number;
  readonly type: "table/snapshot";
  readonly view: {
    readonly phase: "lobby";
    readonly tableId: string;
    readonly viewer: {
      readonly actor: { readonly displayName: string; readonly id: string };
      readonly role: "spectator";
    };
  };
}

function nextMessage(socket: WebSocket): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(JSON.parse(String(event.data)) as SnapshotMessage);
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Snapshot parsing failed."),
          );
        }
      },
      { once: true },
    );
  });
}

describe("public table WebSocket boundary", () => {
  it("authenticates, upgrades, snapshots, evicts, and resyncs", async () => {
    const sessionResponse = await exports.default.fetch(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "Boundary Player" }),
        headers: { "Content-Type": "application/json", Origin: origin },
        method: "POST",
      }),
    );
    expect(sessionResponse.status).toBe(201);
    const cookie = sessionResponse.headers.get("Set-Cookie");
    expect(cookie).not.toBeNull();

    const upgradeResponse = await exports.default.fetch(
      new Request(`${origin}/api/table/socket?tableId=${tableId}`, {
        headers: {
          Cookie: cookie ?? "",
          Origin: origin,
          Upgrade: "websocket",
        },
      }),
    );
    expect(upgradeResponse.status).toBe(101);
    const socket = upgradeResponse.webSocket;
    expect(socket).not.toBeNull();
    if (socket === null)
      throw new Error("WebSocket upgrade returned no socket.");

    const initialMessage = nextMessage(socket);
    socket.accept();
    const initial = await initialMessage;
    expect(initial).toMatchObject({
      protocolVersion: 1,
      stateVersion: 0,
      type: "table/snapshot",
      view: {
        phase: "lobby",
        tableId,
        viewer: {
          actor: { displayName: "Boundary Player" },
          role: "spectator",
        },
      },
    });

    const room = env.TABLE_ROOM.getByName(tableId);
    await evictDurableObject(room);
    const resyncMessage = nextMessage(socket);
    socket.send(
      JSON.stringify({ lastSeenStateVersion: 0, type: "table/resync" }),
    );
    expect(await resyncMessage).toEqual(initial);
    socket.close(1000, "test complete");
  });
});
