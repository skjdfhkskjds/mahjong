import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.js";
import { methodNotAllowed, problemResponse } from "../http/responses.js";

const PROTOCOL_VERSION = 1;
const STATE_VERSION = 0;
const MAX_MESSAGE_BYTES = 2_048;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

const INTERNAL_ACTOR_ID = "X-Mahjong-Actor-Id";
const INTERNAL_CONNECTION_GENERATION = "X-Mahjong-Connection-Generation";
const INTERNAL_DISPLAY_NAME = "X-Mahjong-Display-Name";
const INTERNAL_SESSION_EXPIRES_AT = "X-Mahjong-Session-Expires-At";
const INTERNAL_TABLE_ID = "X-Mahjong-Table-Id";

interface ConnectionAttachment {
  readonly actorId: string;
  readonly connectionGeneration: string;
  readonly connectionId: string;
  readonly displayName: string;
  readonly sessionExpiresAt: number;
  readonly tableId: string;
  readonly version: 1;
}

function boundedHeader(
  request: Request,
  name: string,
  maximum: number,
): string | undefined {
  const value = request.headers.get(name);
  if (value === null || value.length < 1 || value.length > maximum) {
    return undefined;
  }
  return value;
}

function connectionAttachment(
  value: unknown,
): ConnectionAttachment | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate["version"] !== 1 ||
    typeof candidate["actorId"] !== "string" ||
    candidate["actorId"].length < 1 ||
    candidate["actorId"].length > 96 ||
    typeof candidate["connectionId"] !== "string" ||
    candidate["connectionId"].length > 64 ||
    typeof candidate["connectionGeneration"] !== "string" ||
    candidate["connectionGeneration"].length < 1 ||
    candidate["connectionGeneration"].length > 64 ||
    typeof candidate["displayName"] !== "string" ||
    candidate["displayName"].length < 1 ||
    candidate["displayName"].length > 40 ||
    !Number.isSafeInteger(candidate["sessionExpiresAt"]) ||
    (candidate["sessionExpiresAt"] as number) < 0 ||
    typeof candidate["tableId"] !== "string" ||
    !TABLE_ID_PATTERN.test(candidate["tableId"])
  ) {
    return undefined;
  }
  return candidate as unknown as ConnectionAttachment;
}

function snapshot(attachment: ConnectionAttachment): string {
  return JSON.stringify({
    type: "table/snapshot",
    protocolVersion: PROTOCOL_VERSION,
    stateVersion: STATE_VERSION,
    view: {
      phase: "lobby",
      seats: [
        { occupant: null, seat: "east" },
        { occupant: null, seat: "south" },
        { occupant: null, seat: "west" },
        { occupant: null, seat: "north" },
      ],
      tableId: attachment.tableId,
      viewer: {
        actor: { displayName: attachment.displayName, id: attachment.actorId },
        role: "spectator",
      },
    },
  });
}

function isResyncMessage(message: string): boolean {
  try {
    const value = JSON.parse(message) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      Object.keys(candidate).every(
        (key) => key === "type" || key === "lastSeenStateVersion",
      ) &&
      candidate["type"] === "table/resync" &&
      Number.isSafeInteger(candidate["lastSeenStateVersion"]) &&
      (candidate["lastSeenStateVersion"] as number) >= 0
    );
  } catch {
    return false;
  }
}

export class TableRoom extends DurableObject<Env> {
  override fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname !== "/connect") {
      return problemResponse(
        404,
        "not-found",
        "The requested resource was not found.",
      );
    }
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return problemResponse(
        426,
        "upgrade-required",
        "A WebSocket upgrade is required.",
        {
          Upgrade: "websocket",
        },
      );
    }

    const actorId = boundedHeader(request, INTERNAL_ACTOR_ID, 96);
    const connectionGeneration = boundedHeader(
      request,
      INTERNAL_CONNECTION_GENERATION,
      64,
    );
    const displayName = boundedHeader(request, INTERNAL_DISPLAY_NAME, 40);
    const sessionExpiresAtValue = boundedHeader(
      request,
      INTERNAL_SESSION_EXPIRES_AT,
      16,
    );
    const tableId = boundedHeader(request, INTERNAL_TABLE_ID, 64);
    const sessionExpiresAt = Number(sessionExpiresAtValue);
    if (
      actorId === undefined ||
      connectionGeneration === undefined ||
      displayName === undefined ||
      !Number.isSafeInteger(sessionExpiresAt) ||
      sessionExpiresAt <= Date.now() ||
      tableId === undefined ||
      !TABLE_ID_PATTERN.test(tableId)
    ) {
      return problemResponse(
        401,
        "invalid-internal-session",
        "The table session is invalid.",
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectionAttachment = {
      actorId,
      connectionGeneration,
      connectionId: crypto.randomUUID(),
      displayName,
      sessionExpiresAt,
      tableId,
      version: 1,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    server.send(snapshot(attachment));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    const attachment = connectionAttachment(socket.deserializeAttachment());
    if (attachment === undefined || attachment.sessionExpiresAt <= Date.now()) {
      socket.close(1008, "Session expired or invalid");
      return;
    }
    if (typeof message !== "string") {
      socket.close(1003, "Text messages only");
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, "Message too large");
      return;
    }
    if (!isResyncMessage(message)) {
      socket.close(1008, "Unsupported message");
      return;
    }
    socket.send(snapshot(attachment));
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    void error;
    socket.close(1011, "WebSocket error");
  }
}
