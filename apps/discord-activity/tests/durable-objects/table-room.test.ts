import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";

interface SnapshotMessage {
  readonly protocolVersion: number;
  readonly stateVersion: number;
  readonly type: string;
  readonly view: {
    readonly tableId: string;
    readonly viewer: {
      readonly actor: { readonly displayName: string; readonly id: string };
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

describe("TableRoom hibernatable WebSocket", () => {
  it("sends viewer-safe snapshots and resyncs after forced eviction", async () => {
    const namespace = (
      env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
    ).TABLE_ROOM;
    const stub = namespace.getByName("walking-skeleton");
    const response = await stub.fetch(
      new Request("https://table-room.internal/connect", {
        headers: {
          Upgrade: "websocket",
          "X-Mahjong-Actor-Id": "mock:test-actor",
          "X-Mahjong-Connection-Generation": crypto.randomUUID(),
          "X-Mahjong-Display-Name": "Test Actor",
          "X-Mahjong-Session-Expires-At": String(Date.now() + 60_000),
          "X-Mahjong-Table-Id": "walking-skeleton",
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    if (socket === null)
      throw new Error("WebSocket upgrade did not return a socket.");
    const initialMessage = nextMessage(socket);
    socket.accept();
    const initial = await initialMessage;
    expect(initial).toMatchObject({
      protocolVersion: 1,
      stateVersion: 0,
      type: "table/snapshot",
      view: {
        tableId: "walking-skeleton",
        viewer: {
          actor: { displayName: "Test Actor", id: "mock:test-actor" },
        },
      },
    });

    const beforeEviction = nextMessage(socket);
    socket.send(
      JSON.stringify({ lastSeenStateVersion: 0, type: "table/resync" }),
    );
    expect(await beforeEviction).toEqual(initial);

    await evictDurableObject(stub);
    const afterEviction = nextMessage(socket);
    socket.send(
      JSON.stringify({ lastSeenStateVersion: 0, type: "table/resync" }),
    );
    expect(await afterEviction).toEqual(initial);
    socket.close(1000, "test complete");
  });
});
