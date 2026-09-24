import { initializeTableRoomStorage } from "./table-room/table-room-schema.js";
import {
  activateTableConnection,
  closeTableConnection,
  connectionAuthorityIsCurrent,
  reconcileTableWork,
  type ConnectionGrant,
} from "./table-room/table-connection-application.js";
import { SqliteTableConnectionStore } from "./table-room/table-connection-store.js";
import { executeTableCommand } from "./table-room/table-command-application.js";
import { SqliteTableCommandStore } from "./table-room/table-command-store.js";
import { processTableDeadline } from "./table-room/table-system-application.js";
import { DurableObject } from "cloudflare:workers";
import {
  activateAccessSession,
  applyAccessBinding,
  issueAccessCapability,
  redeemAccessInvitation,
} from "./table-room/table-access-application.js";
import { SqliteTableAccessStore } from "./table-room/table-access-store.js";
import {
  decodeCanonicalGameJson,
  type CanonicalGameStateV1,
  type GameViewV1,
} from "@mahjong/rules-hong-kong";

import {
  projectTableGame,
  tableGameActorAt,
  tableGamePhase,
} from "./table-room/table-room-game-engine.js";
import {
  botWorkTarget,
  chooseBotMove,
  readBotWork,
  readPlayerControls,
} from "./table-room/table-room-bots.js";
import {
  TablePlayers,
  type PlayerCommandResult,
} from "../players/table-players.js";
import type { ControllerAuthority } from "../players/player-coordinator.js";
import type { PlayerControl } from "./table-room/table-player-control.js";
import type { PlayerView } from "../players/player.js";
import {
  heartbeatPresenceExpiresAt,
  TABLE_HEARTBEAT_INTERVAL_MS,
  TABLE_HEARTBEAT_READY,
  TABLE_HEARTBEAT_REQUEST,
  TABLE_HEARTBEAT_RESPONSE,
} from "./table-room/table-room-heartbeat.js";
import {
  isValidApplicationActor,
  isValidApplicationDisplayName,
  type ApplicationActor,
} from "../auth/application-session.js";
import type { Env } from "../env.js";
import {
  jsonResponse,
  methodNotAllowed,
  problemResponse,
} from "../http/responses.js";
import {
  earliestPendingDeadline,
  MAX_DUE_DEADLINE_BATCH,
  planAlarmRepair,
  readDueDeadlines,
  verifyDeadlinePersistence,
  type PendingDeadline,
} from "./table-room/deadline-queue.js";
import { verifyStoredGame } from "./table-room/table-room-game-store.js";
import {
  parseTableCommand,
  parseTableResync,
  protocolUpgradeMessage,
  requestedTableProtocol,
  TABLE_PROTOCOL_UPGRADE_CLOSE_CODE,
  TABLE_PROTOCOL_VERSION,
  type TableCommandEnvelope,
  type TableSeat,
} from "./table-room/table-room-protocol.js";
import {
  readAutomationByActor,
  readRoomLifecycle,
  type PresenceObservation,
} from "./table-room/table-room-presence.js";

const MAX_MESSAGE_BYTES = 16_384;
const MAX_INTERNAL_BODY_BYTES = 4_096;
const MAX_CLOCK_SKEW_MS = 60_000;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHORT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

const INTERNAL_ACTOR_ID = "X-Mahjong-Actor-Id";
const INTERNAL_BINDING_GENERATION = "X-Mahjong-Binding-Generation";
const INTERNAL_BINDING_PROOF = "X-Mahjong-Binding-Proof";
const INTERNAL_CONNECTION_GENERATION = "X-Mahjong-Connection-Generation";
const INTERNAL_DISPLAY_NAME = "X-Mahjong-Display-Name";
const INTERNAL_INSTANCE_ID = "X-Mahjong-Instance-Id";
const INTERNAL_SESSION_EXPIRES_AT = "X-Mahjong-Session-Expires-At";
const INTERNAL_SESSION_GENERATION = "X-Mahjong-Session-Generation";
const INTERNAL_TABLE_ID = "X-Mahjong-Table-Id";

type Actor = ApplicationActor;
type Seat = TableSeat;

const SEATS: readonly Seat[] = ["east", "south", "west", "north"];

interface BindingAuthorization {
  readonly bindingGeneration: number;
  readonly bindingProof: string;
  readonly instanceId: string;
}

interface ApplyBindingRequest {
  readonly actor: Actor;
  readonly deadlineAt: number;
  readonly instanceId: string;
  readonly intent:
    | { readonly kind: "create" }
    | { readonly capability: string; readonly kind: "resume" };
  readonly operationId: string;
  readonly version: 1;
}

interface CapabilityCreateRequest extends BindingAuthorization {
  readonly actorId: string;
  readonly invitedActorId?: string;
  readonly now: number;
  readonly sessionGeneration: number;
  readonly version: 1;
}

interface InvitationRedeemRequest extends BindingAuthorization {
  readonly actor: Actor;
  readonly capability: string;
  readonly now: number;
  readonly sessionGeneration: number;
  readonly version: 1;
}

interface SessionActivateRequest extends BindingAuthorization {
  readonly actorId: string;
  readonly sessionGeneration: number;
  readonly version: 1;
  readonly departure?: true;
}

interface ConnectionAttachment {
  readonly actorId: string;
  readonly connectionGeneration: string;
  readonly connectionId: string;
  readonly sessionExpiresAt: number;
  readonly version: 1;
  readonly heartbeatAcceptedAt?: number;
}

interface StoredResult {
  readonly body: unknown;
  readonly status: number;
}

interface ParsedCapability {
  readonly capabilityId: string;
  readonly secret: string;
  readonly tableId: string;
}

interface LobbySeatRow {
  readonly [key: string]: SqlStorageValue;
  readonly actor_id: string;
  readonly display_name: string;
  readonly ready: number;
  readonly seat: Seat;
}

interface ViewerSafeActor {
  readonly displayName: string;
  readonly id: string;
}

interface ViewerSafeTableSnapshot {
  readonly type: "table/snapshot";
  readonly protocolVersion: 1;
  readonly stateVersion: number;
  readonly view: {
    readonly phase:
      "abandoned" | "complete" | "exhausted" | "lobby" | "playing";
    readonly game?: GameViewV1 & { readonly deadlineAt: number | null };
    readonly seats: readonly {
      readonly occupant: ViewerSafeActor | null;
      readonly autopilot: boolean;
      readonly ready: boolean;
      readonly seat: Seat;
    }[];
    readonly spectators: readonly ViewerSafeActor[];
    readonly tableId: string;
    readonly viewer:
      | {
          readonly actor: ViewerSafeActor;
          readonly role: "player";
          readonly seat: Seat;
        }
      | { readonly actor: ViewerSafeActor; readonly role: "spectator" };
  };
}

interface ViewerSafeTableReceipt {
  readonly type: "table/receipt";
  readonly protocolVersion: 1;
  readonly commandId: string;
  readonly outcome: "applied" | "rejected";
  readonly stateVersion: number;
  readonly error?: { readonly code: string; readonly message: string };
}

interface ViewerSafeSessionReplaced {
  readonly type: "session/replaced";
  readonly protocolVersion: 1;
}

type ViewerSafeServerMessage =
  ViewerSafeTableSnapshot | ViewerSafeTableReceipt | ViewerSafeSessionReplaced;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  return (
    Object.keys(value).length === required.length &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function validActorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 96 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function validInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function parseActor(value: unknown): Actor | undefined {
  return isValidApplicationActor(value) ? value : undefined;
}

function parseBindingAuthorization(
  value: Record<string, unknown>,
): BindingAuthorization | undefined {
  if (
    !validInstanceId(value["instanceId"]) ||
    !Number.isSafeInteger(value["bindingGeneration"]) ||
    (value["bindingGeneration"] as number) < 1 ||
    typeof value["bindingProof"] !== "string" ||
    !TOKEN_PATTERN.test(value["bindingProof"])
  ) {
    return undefined;
  }
  return {
    bindingGeneration: value["bindingGeneration"] as number,
    bindingProof: value["bindingProof"],
    instanceId: value["instanceId"],
  };
}

function parseApplyBindingRequest(
  value: unknown,
): ApplyBindingRequest | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "actor",
      "deadlineAt",
      "instanceId",
      "intent",
      "operationId",
      "version",
    ]) ||
    value["version"] !== 1 ||
    typeof value["operationId"] !== "string" ||
    !SHORT_TOKEN_PATTERN.test(value["operationId"]) ||
    !validInstanceId(value["instanceId"]) ||
    !Number.isSafeInteger(value["deadlineAt"])
  ) {
    return undefined;
  }
  const actor = parseActor(value["actor"]);
  const intent = value["intent"];
  if (actor === undefined || !isRecord(intent)) return undefined;
  if (intent["kind"] === "create" && hasExactKeys(intent, ["kind"])) {
    return {
      actor,
      deadlineAt: value["deadlineAt"] as number,
      instanceId: value["instanceId"],
      intent: { kind: "create" },
      operationId: value["operationId"],
      version: 1,
    };
  }
  if (
    intent["kind"] === "resume" &&
    hasExactKeys(intent, ["capability", "kind"]) &&
    typeof intent["capability"] === "string" &&
    intent["capability"].length <= 256
  ) {
    return {
      actor,
      deadlineAt: value["deadlineAt"] as number,
      instanceId: value["instanceId"],
      intent: { capability: intent["capability"], kind: "resume" },
      operationId: value["operationId"],
      version: 1,
    };
  }
  return undefined;
}

function parseCapabilityCreateRequest(
  value: unknown,
  invitation: boolean,
): CapabilityCreateRequest | undefined {
  if (!isRecord(value)) return undefined;
  const required = invitation
    ? [
        "actorId",
        "bindingGeneration",
        "bindingProof",
        "instanceId",
        "invitedActorId",
        "now",
        "sessionGeneration",
        "version",
      ]
    : [
        "actorId",
        "bindingGeneration",
        "bindingProof",
        "instanceId",
        "now",
        "sessionGeneration",
        "version",
      ];
  const authorization = parseBindingAuthorization(value);
  if (
    !hasExactKeys(value, required) ||
    authorization === undefined ||
    value["version"] !== 1 ||
    !validActorId(value["actorId"]) ||
    (invitation && !validActorId(value["invitedActorId"])) ||
    !Number.isSafeInteger(value["now"]) ||
    Math.abs((value["now"] as number) - Date.now()) > MAX_CLOCK_SKEW_MS ||
    !Number.isSafeInteger(value["sessionGeneration"]) ||
    (value["sessionGeneration"] as number) < 1
  ) {
    return undefined;
  }
  return {
    ...authorization,
    actorId: value["actorId"],
    ...(invitation
      ? { invitedActorId: value["invitedActorId"] as string }
      : {}),
    now: value["now"] as number,
    sessionGeneration: value["sessionGeneration"] as number,
    version: 1,
  };
}

function parseInvitationRedeemRequest(
  value: unknown,
): InvitationRedeemRequest | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "actor",
      "bindingGeneration",
      "bindingProof",
      "capability",
      "instanceId",
      "now",
      "sessionGeneration",
      "version",
    ]) ||
    value["version"] !== 1 ||
    typeof value["capability"] !== "string" ||
    value["capability"].length > 256 ||
    !Number.isSafeInteger(value["now"]) ||
    Math.abs((value["now"] as number) - Date.now()) > MAX_CLOCK_SKEW_MS ||
    !Number.isSafeInteger(value["sessionGeneration"]) ||
    (value["sessionGeneration"] as number) < 1
  ) {
    return undefined;
  }
  const actor = parseActor(value["actor"]);
  const authorization = parseBindingAuthorization(value);
  if (actor === undefined || authorization === undefined) return undefined;
  return {
    ...authorization,
    actor,
    capability: value["capability"],
    now: value["now"] as number,
    sessionGeneration: value["sessionGeneration"] as number,
    version: 1,
  };
}

function parseSessionActivateRequest(
  value: unknown,
): SessionActivateRequest | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "actorId",
      "bindingGeneration",
      "bindingProof",
      "instanceId",
      "sessionGeneration",
      "version",
      ...(Object.hasOwn(value, "departure") ? ["departure"] : []),
    ]) ||
    value["version"] !== 1 ||
    !validActorId(value["actorId"]) ||
    !Number.isSafeInteger(value["sessionGeneration"]) ||
    (value["sessionGeneration"] as number) < 1 ||
    (Object.hasOwn(value, "departure") && value["departure"] !== true)
  ) {
    return undefined;
  }
  const authorization = parseBindingAuthorization(value);
  if (authorization === undefined) return undefined;
  return {
    ...authorization,
    actorId: value["actorId"],
    sessionGeneration: value["sessionGeneration"] as number,
    version: 1,
    ...(value["departure"] === true ? { departure: true as const } : {}),
  };
}

function boundedHeader(
  request: Request,
  name: string,
  maximum: number,
): string | undefined {
  const value = request.headers.get(name);
  return value !== null && value.length >= 1 && value.length <= maximum
    ? value
    : undefined;
}

function decodeDisplayNameHeader(
  value: string | undefined,
): string | undefined {
  if (value === undefined || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) {
    return undefined;
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    const displayName = new TextDecoder(undefined, {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    return isValidApplicationDisplayName(displayName) ? displayName : undefined;
  } catch {
    return undefined;
  }
}

function connectionAttachment(
  value: unknown,
): ConnectionAttachment | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "actorId",
      "connectionGeneration",
      "connectionId",
      "sessionExpiresAt",
      "version",
      ...(Object.hasOwn(value, "heartbeatAcceptedAt")
        ? ["heartbeatAcceptedAt"]
        : []),
    ]) ||
    value["version"] !== 1 ||
    !validActorId(value["actorId"]) ||
    typeof value["connectionId"] !== "string" ||
    !SHORT_TOKEN_PATTERN.test(value["connectionId"]) ||
    typeof value["connectionGeneration"] !== "string" ||
    !SHORT_TOKEN_PATTERN.test(value["connectionGeneration"]) ||
    !Number.isSafeInteger(value["sessionExpiresAt"]) ||
    (value["sessionExpiresAt"] as number) < 0 ||
    (Object.hasOwn(value, "heartbeatAcceptedAt") &&
      (!Number.isSafeInteger(value["heartbeatAcceptedAt"]) ||
        (value["heartbeatAcceptedAt"] as number) < 0))
  ) {
    return undefined;
  }
  return value as unknown as ConnectionAttachment;
}

function serializeViewerMessage(message: ViewerSafeServerMessage): string {
  return JSON.stringify(message);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function randomCapabilityId(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

async function sha256(value: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

function parseCapability(value: string): ParsedCapability | undefined {
  const parts = value.split(".");
  const [version, tableId, capabilityId, secret] = parts;
  if (
    parts.length !== 4 ||
    version !== "v1" ||
    tableId === undefined ||
    !TABLE_ID_PATTERN.test(tableId) ||
    capabilityId === undefined ||
    !CAPABILITY_ID_PATTERN.test(capabilityId) ||
    secret === undefined ||
    !TOKEN_PATTERN.test(secret)
  ) {
    return undefined;
  }
  return { capabilityId, secret, tableId };
}

function storedResponse(result: StoredResult): Response {
  return jsonResponse(result.body, result.status);
}

function lobbyReceipt(
  commandId: string,
  outcome: "applied" | "rejected",
  stateVersion: number,
  error?: { readonly code: string; readonly message: string },
): string {
  const message: ViewerSafeTableReceipt = {
    type: "table/receipt",
    protocolVersion: TABLE_PROTOCOL_VERSION,
    commandId,
    outcome,
    stateVersion,
    ...(error === undefined ? {} : { error }),
  };
  return serializeViewerMessage(message);
}

export class TableRoom extends DurableObject<Env> {
  private readonly players: TablePlayers;

  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        TABLE_HEARTBEAT_REQUEST,
        TABLE_HEARTBEAT_RESPONSE,
      ),
    );
    this.players = new TablePlayers({
      control: (actorId) => this.playerControl(actorId),
      view: (actorId) => this.playerView(actorId),
      communication: (actorId) => ({
        connections: () =>
          this.ctx.getWebSockets().flatMap((socket) => {
            const attachment = connectionAttachment(
              socket.deserializeAttachment(),
            );
            if (attachment?.actorId !== actorId) return [];
            return [
              {
                id: attachment.connectionId,
                usable: this.socketIsUsable(socket, Date.now()),
              },
            ];
          }),
        send: (connectionId, input) => {
          const socket = this.ctx
            .getWebSockets()
            .find(
              (candidate) =>
                connectionAttachment(candidate.deserializeAttachment())
                  ?.connectionId === connectionId,
            );
          const attachment =
            socket === undefined
              ? undefined
              : connectionAttachment(socket.deserializeAttachment());
          if (
            socket === undefined ||
            attachment?.actorId !== actorId ||
            socket.readyState !== WebSocket.OPEN ||
            (input.type === "view" && !this.socketIsUsable(socket, Date.now()))
          )
            throw new Error("Player connection is unavailable.");
          socket.send(input.type === "view" ? input.snapshot : input.message);
        },
      }),
      choose: (view) => {
        const random = crypto.getRandomValues(new Uint32Array(1))[0];
        if (random === undefined)
          throw new Error("Bot randomness unavailable.");
        return chooseBotMove(view, random / 0x1_0000_0000);
      },
      apply: (actorId, command, authority, connectionId) =>
        this.applyTableCommand(
          actorId,
          command,
          Date.now(),
          authority,
          connectionId,
        ),
    });
    initializeTableRoomStorage(this.ctx.storage);
    const sql = this.ctx.storage.sql;
    void this.ctx.blockConcurrencyWhile(async () => {
      verifyDeadlinePersistence(sql);
      const game = await verifyStoredGame(sql);
      const now = Date.now();
      reconcileTableWork(new SqliteTableConnectionStore(this.ctx.storage), {
        now,
        observations: this.presenceObservations(),
        game: game?.state,
        createCommandId: () => crypto.randomUUID(),
      });
      await this.repairAlarm();
    });
  }

  public override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/connect") return this.connectWebSocket(request);
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const value = await this.readInternalJson(request);
    if (value === undefined) {
      return problemResponse(
        400,
        "invalid-internal-request",
        "The internal request is malformed.",
      );
    }
    switch (pathname) {
      case "/internal/bindings/apply":
        return this.applyBinding(value);
      case "/internal/invitations/create":
        return this.createCapability(value, "invitation");
      case "/internal/invitations/redeem":
        return this.redeemInvitation(value);
      case "/internal/resume-capabilities/create":
        return this.createCapability(value, "resume");
      case "/internal/sessions/activate":
        return this.activateSession(value);
      default:
        return problemResponse(
          404,
          "not-found",
          "The requested resource was not found.",
        );
    }
  }

  private async readInternalJson(request: Request): Promise<unknown> {
    if (
      request.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      return undefined;
    }
    const contentLength = Number(request.headers.get("Content-Length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_INTERNAL_BODY_BYTES
    ) {
      return undefined;
    }
    try {
      const text = await request.text();
      if (
        text.length < 1 ||
        new TextEncoder().encode(text).byteLength > MAX_INTERNAL_BODY_BYTES
      ) {
        return undefined;
      }
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  private tableId(): string | undefined {
    const name = this.ctx.id.name;
    return typeof name === "string" && TABLE_ID_PATTERN.test(name)
      ? name
      : undefined;
  }

  private stateVersion(): number {
    return this.ctx.storage.sql
      .exec<{ state_version: number }>(
        "SELECT state_version FROM lobby_state WHERE singleton = 1",
      )
      .one().state_version;
  }

  private gameState():
    | { readonly state: CanonicalGameStateV1; readonly lastEventHash: string }
    | undefined {
    const row = this.ctx.storage.sql
      .exec<{ state_json: string; last_event_hash: string }>(
        "SELECT state_json, last_event_hash FROM canonical_game_state WHERE singleton = 1",
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    const state = decodeCanonicalGameJson(row.state_json);
    return { state, lastEventHash: row.last_event_hash };
  }

  private roomLifecycle(): {
    readonly abandoned: boolean;
    readonly roomActivityGeneration: number;
  } {
    return readRoomLifecycle(this.ctx.storage.sql);
  }

  private gameDeadlineAt(): number | null {
    return (
      this.ctx.storage.sql
        .exec<{ due_at: number }>(
          "SELECT due_at FROM deadlines WHERE status = 'pending' AND kind IN ('reaction', 'turn') ORDER BY due_at, deadline_id LIMIT 1",
        )
        .toArray()[0]?.due_at ?? null
    );
  }

  private automationByActor(): ReadonlyMap<string, boolean> {
    return readAutomationByActor(this.ctx.storage.sql);
  }

  private playerControl(actorId: string): PlayerControl {
    return (
      readPlayerControls(this.ctx.storage.sql).find(
        (control) => control.actorId === actorId,
      ) ?? { actorId, kind: "HUMAN", controller: "HUMAN", generation: 0 }
    );
  }

  private playerView(actorId: string): PlayerView {
    const game = this.gameState()?.state;
    let snapshot = "";
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = connectionAttachment(socket.deserializeAttachment());
      if (attachment?.actorId !== actorId) continue;
      const grant = this.connectionGrant(attachment);
      if (grant !== undefined && this.grantIsCurrent(grant, Date.now())) {
        snapshot = this.snapshot(attachment, grant);
        break;
      }
    }
    return {
      type: "view",
      stateVersion: this.stateVersion(),
      snapshot,
      ...(game === undefined ? {} : { game: projectTableGame(game, actorId) }),
    };
  }

  private socketIsUsable(socket: WebSocket, now: number): boolean {
    const attachment = connectionAttachment(socket.deserializeAttachment());
    const grant =
      attachment === undefined ? undefined : this.connectionGrant(attachment);
    return (
      socket.readyState === WebSocket.OPEN &&
      attachment !== undefined &&
      grant !== undefined &&
      this.grantIsCurrent(grant, now) &&
      this.socketPresenceExpiresAt(socket, attachment) > now
    );
  }

  private socketPresenceExpiresAt(
    socket: WebSocket,
    attachment: ConnectionAttachment,
  ): number {
    if (attachment.heartbeatAcceptedAt === undefined)
      return attachment.sessionExpiresAt;
    const timestamp = this.ctx
      .getWebSocketAutoResponseTimestamp(socket)
      ?.getTime();
    return heartbeatPresenceExpiresAt({
      acceptedAt: attachment.heartbeatAcceptedAt,
      ...(timestamp === undefined ? {} : { lastHeartbeatAt: timestamp }),
      sessionExpiresAt: attachment.sessionExpiresAt,
    });
  }

  private snapshot(
    attachment: ConnectionAttachment,
    grant: ConnectionGrant,
  ): string {
    const seats = this.ctx.storage.sql
      .exec<LobbySeatRow>(
        "SELECT seat, actor_id, display_name, ready FROM lobby_seats",
      )
      .toArray();
    const seatsByName = new Map(seats.map((seat) => [seat.seat, seat]));
    const game = this.gameState();
    const lifecycle = this.roomLifecycle();
    const automation = this.automationByActor();
    const viewerSeat =
      game === undefined
        ? seats.find(({ actor_id }) => actor_id === attachment.actorId)?.seat
        : SEATS.find(
            (seat) => tableGameActorAt(game.state, seat) === attachment.actorId,
          );
    const viewer = this.ctx.storage.sql
      .exec<{ actor_id: string; display_name: string }>(
        "SELECT actor_id, display_name FROM members WHERE actor_id = ?",
        attachment.actorId,
      )
      .one();
    const spectators = this.ctx.storage.sql
      .exec<{ actor_id: string; display_name: string }>(
        "SELECT members.actor_id, members.display_name FROM members LEFT JOIN lobby_seats ON lobby_seats.actor_id = members.actor_id WHERE lobby_seats.actor_id IS NULL ORDER BY members.joined_at, members.actor_id",
      )
      .toArray()
      .map(({ actor_id, display_name }) => ({
        displayName: display_name,
        id: actor_id,
      }));
    const message: ViewerSafeTableSnapshot = {
      type: "table/snapshot",
      protocolVersion: TABLE_PROTOCOL_VERSION,
      stateVersion: this.stateVersion(),
      view: {
        phase: lifecycle.abandoned
          ? "abandoned"
          : game === undefined
            ? "lobby"
            : tableGamePhase(game.state),
        ...(game === undefined
          ? {}
          : {
              game: {
                ...projectTableGame(game.state, attachment.actorId),
                deadlineAt: this.gameDeadlineAt(),
              },
            }),
        seats: SEATS.map((seat) => {
          const gameActorId =
            game === undefined ? undefined : tableGameActorAt(game.state, seat);
          const row =
            gameActorId === undefined
              ? seatsByName.get(seat)
              : seats.find(({ actor_id }) => actor_id === gameActorId);
          return {
            occupant:
              row === undefined
                ? null
                : { displayName: row.display_name, id: row.actor_id },
            autopilot:
              row === undefined
                ? false
                : (automation.get(row.actor_id) ?? false),
            ready: row?.ready === 1,
            seat,
          };
        }),
        spectators,
        tableId: grant.tableId,
        viewer: {
          actor: { displayName: viewer.display_name, id: viewer.actor_id },
          ...(viewerSeat === undefined
            ? { role: "spectator" as const }
            : { role: "player" as const, seat: viewerSeat }),
        },
      },
    };
    return serializeViewerMessage(message);
  }

  private broadcastSnapshots(excludedConnectionId?: string): void {
    const now = Date.now();
    const actorIds = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = connectionAttachment(socket.deserializeAttachment());
      if (
        attachment?.connectionId === excludedConnectionId ||
        socket.readyState !== WebSocket.OPEN
      )
        continue;
      const grant =
        attachment === undefined ? undefined : this.connectionGrant(attachment);
      if (
        attachment === undefined ||
        grant === undefined ||
        !this.grantIsCurrent(grant, now)
      ) {
        socket.close(1008, "Session expired, replaced, or invalid");
        continue;
      }
      actorIds.add(attachment.actorId);
    }
    for (const actorId of actorIds)
      this.players.publish(actorId, excludedConnectionId);
  }

  /** Caller holds serialization across application preparation and atomic commit. */
  private applyTableCommand(
    actorId: string,
    envelope: TableCommandEnvelope,
    now: number,
    authority: ControllerAuthority,
    connectionId?: string,
  ): Promise<PlayerCommandResult> {
    const departing =
      envelope.command.type === "lobby/leave-seat" &&
      this.gameState() !== undefined
        ? this.ctx
            .getWebSockets()
            .map((socket) =>
              connectionAttachment(socket.deserializeAttachment()),
            )
            .find((attachment) => attachment?.connectionId === connectionId)
        : undefined;
    return executeTableCommand(new SqliteTableCommandStore(this.ctx.storage), {
      actorId,
      envelope,
      now,
      authority,
      observations: this.presenceObservations(departing?.connectionId),
      randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
      createCommandId: () => crypto.randomUUID(),
      newBotActorId: () => `bot:${crypto.randomUUID()}`,
      ...(departing === undefined
        ? {}
        : { departingConnectionGeneration: departing.connectionGeneration }),
    });
  }

  private presenceObservations(
    excludedConnectionId?: string,
  ): readonly PresenceObservation[] {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = connectionAttachment(socket.deserializeAttachment());
      if (
        attachment === undefined ||
        socket.readyState !== WebSocket.OPEN ||
        attachment.connectionId === excludedConnectionId
      ) {
        return [];
      }
      const grant = this.connectionGrant(attachment);
      return grant !== undefined && this.grantAuthorityIsCurrent(grant)
        ? [
            {
              actorId: grant.actorId,
              expiresAt: this.socketPresenceExpiresAt(socket, attachment),
            },
          ]
        : [];
    });
  }

  private processDeadline(
    deadline: PendingDeadline,
    now: number,
  ): Promise<boolean> {
    const payload = deadline.payload;
    const desiredBotActorIds = new Set<string>();
    if (
      payload.type === "system/disconnect-grace-expired" &&
      this.players.health(payload.actorId).desiredController === "BOT"
    ) {
      desiredBotActorIds.add(payload.actorId);
    }
    return processTableDeadline(
      new SqliteTableCommandStore(this.ctx.storage),
      deadline.deadlineId,
      now,
      this.presenceObservations(),
      { desiredBotActorIds, createCommandId: () => crypto.randomUUID() },
    );
  }

  private async drainDueDeadlines(now: number): Promise<boolean> {
    reconcileTableWork(new SqliteTableConnectionStore(this.ctx.storage), {
      now,
      observations: this.presenceObservations(),
      game: this.gameState()?.state,
      refreshGameDeadlines: false,
      createCommandId: () => crypto.randomUUID(),
    });
    const due = readDueDeadlines(
      this.ctx.storage.sql,
      now,
      MAX_DUE_DEADLINE_BATCH,
    );
    let broadcast = false;
    for (const deadline of due) {
      const transitioned = await this.processDeadline(deadline, now);
      broadcast = transitioned || broadcast;
    }
    // Human deadlines win at their boundary. Bot commands then use the same
    // validated, receipt-backed transition path under the room concurrency gate.
    for (const work of readBotWork(this.ctx.storage.sql)) {
      if (work.due_at > now || this.roomLifecycle().abandoned) continue;
      const state = this.gameState()?.state;
      if (!state || botWorkTarget(state, work.actor_id) !== work.target)
        continue;
      const result = await this.players.bot(
        work.actor_id,
        work.controller_generation,
        work.command_id,
        this.stateVersion(),
      );
      if (result === undefined) continue;
      if (!result.applied)
        throw new Error("A persisted bot move could not be applied.");
      broadcast ||= result.broadcast;
    }
    await this.repairAlarm();
    return broadcast;
  }

  private async repairAlarm(): Promise<void> {
    const now = Date.now();
    // Fresh observations on every repair prevent ordinary traffic postponing health checks.
    reconcileTableWork(new SqliteTableConnectionStore(this.ctx.storage), {
      now,
      observations: this.presenceObservations(),
      game: this.gameState()?.state,
      refreshGameDeadlines: false,
      createCommandId: () => crypto.randomUUID(),
    });
    const current = await this.ctx.storage.getAlarm();
    const pending = [
      earliestPendingDeadline(this.ctx.storage.sql),
      readBotWork(this.ctx.storage.sql)[0]?.due_at,
      this.ctx.getWebSockets().some((socket) => {
        const attachment = connectionAttachment(socket.deserializeAttachment());
        return (
          attachment?.heartbeatAcceptedAt !== undefined &&
          this.socketIsUsable(socket, now)
        );
      })
        ? now + TABLE_HEARTBEAT_INTERVAL_MS
        : undefined,
    ].filter((value): value is number => value !== undefined);
    const plan = planAlarmRepair(
      current,
      pending.length > 0 ? Math.min(...pending) : undefined,
    );
    if (plan.action === "set") {
      await this.ctx.storage.setAlarm(plan.scheduledTime);
    } else if (plan.action === "delete") {
      await this.ctx.storage.deleteAlarm();
    }
  }

  public override async alarm(): Promise<void> {
    const now = Date.now();
    const broadcast = await this.ctx.blockConcurrencyWhile(() =>
      this.drainDueDeadlines(now),
    );
    if (broadcast) this.broadcastSnapshots();
  }

  private async applyBinding(value: unknown): Promise<Response> {
    const body = parseApplyBindingRequest(value);
    const tableId = this.tableId();
    if (body === undefined || tableId === undefined) {
      return problemResponse(
        400,
        "invalid-binding-request",
        "The binding request is invalid.",
      );
    }
    const capability =
      body.intent.kind === "resume"
        ? parseCapability(body.intent.capability)
        : undefined;
    if (body.intent.kind === "resume" && capability?.tableId !== tableId) {
      return problemResponse(
        403,
        "invalid-capability",
        "The capability is invalid.",
      );
    }
    const intent =
      capability === undefined
        ? { kind: "create" as const }
        : {
            kind: "resume" as const,
            capabilityId: capability.capabilityId,
            capabilitySecretHash: await sha256(capability.secret),
            tableId: capability.tableId,
          };
    return storedResponse(
      applyAccessBinding(
        new SqliteTableAccessStore(this.ctx.storage),
        {
          actor: body.actor,
          deadlineAt: body.deadlineAt,
          instanceId: body.instanceId,
          intent,
          operationId: body.operationId,
        },
        { tableId, now: Date.now(), bindingProof: randomToken() },
      ),
    );
  }

  private async createCapability(
    value: unknown,
    kind: "invitation" | "resume",
  ): Promise<Response> {
    const body = parseCapabilityCreateRequest(value, kind === "invitation");
    if (body === undefined) {
      return problemResponse(
        400,
        "invalid-capability-request",
        "The capability request is invalid.",
      );
    }
    const capabilityId = randomCapabilityId();
    const secret = randomToken();
    const secretHash = await sha256(secret);
    return storedResponse(
      issueAccessCapability(
        new SqliteTableAccessStore(this.ctx.storage),
        body,
        { kind, capabilityId, secret, secretHash, now: Date.now() },
      ),
    );
  }

  private async redeemInvitation(value: unknown): Promise<Response> {
    const body = parseInvitationRedeemRequest(value);
    if (body === undefined) {
      return problemResponse(
        400,
        "invalid-invitation-request",
        "The invitation request is invalid.",
      );
    }
    const capability = parseCapability(body.capability);
    if (capability === undefined) {
      return problemResponse(
        403,
        "invalid-capability",
        "The capability is invalid.",
      );
    }
    const secretHash = await sha256(capability.secret);
    const outcome = redeemAccessInvitation(
      new SqliteTableAccessStore(this.ctx.storage),
      body,
      {
        tableId: capability.tableId,
        capabilityId: capability.capabilityId,
        secretHash,
        now: Date.now(),
      },
    );
    if (outcome.publishSnapshots) this.broadcastSnapshots();
    return storedResponse(outcome.result);
  }

  private async activateSession(value: unknown): Promise<Response> {
    const body = parseSessionActivateRequest(value);
    if (body === undefined) {
      return problemResponse(
        400,
        "invalid-session-request",
        "The session activation request is invalid.",
      );
    }
    const outcome = activateAccessSession(
      new SqliteTableAccessStore(this.ctx.storage),
      body,
      {
        now: Date.now(),
        observations: this.presenceObservations(),
        game: this.gameState()?.state,
        createCommandId: () => crypto.randomUUID(),
      },
    );
    if (outcome.replaceActorSockets !== undefined) {
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = connectionAttachment(socket.deserializeAttachment());
        if (attachment?.actorId === outcome.replaceActorSockets) {
          socket.send(
            serializeViewerMessage({
              type: "session/replaced",
              protocolVersion: TABLE_PROTOCOL_VERSION,
            }),
          );
          socket.close(4001, "Session replaced");
        }
      }
    }
    if (outcome.departed) {
      this.players.changed(body.actorId);
      this.broadcastSnapshots();
    }
    await this.repairAlarm();
    return storedResponse(outcome.result);
  }

  private async connectWebSocket(request: Request): Promise<Response> {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return problemResponse(
        426,
        "upgrade-required",
        "A WebSocket upgrade is required.",
        { Upgrade: "websocket" },
      );
    }
    if (requestedTableProtocol(request.url) === undefined) {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.send(protocolUpgradeMessage());
      server.close(
        TABLE_PROTOCOL_UPGRADE_CLOSE_CODE,
        "Gameplay protocol upgrade required",
      );
      return new Response(null, { status: 101, webSocket: client });
    }
    const now = Date.now();
    const actorId = boundedHeader(request, INTERNAL_ACTOR_ID, 96);
    const connectionGeneration = boundedHeader(
      request,
      INTERNAL_CONNECTION_GENERATION,
      64,
    );
    const displayName = decodeDisplayNameHeader(
      boundedHeader(request, INTERNAL_DISPLAY_NAME, 256),
    );
    const sessionExpiresAt = Number(
      boundedHeader(request, INTERNAL_SESSION_EXPIRES_AT, 16),
    );
    const tableId = boundedHeader(request, INTERNAL_TABLE_ID, 64);
    const instanceId = boundedHeader(request, INTERNAL_INSTANCE_ID, 128);
    const bindingGeneration = Number(
      boundedHeader(request, INTERNAL_BINDING_GENERATION, 16),
    );
    const bindingProof = boundedHeader(request, INTERNAL_BINDING_PROOF, 64);
    const sessionGeneration = Number(
      boundedHeader(request, INTERNAL_SESSION_GENERATION, 16),
    );
    if (
      actorId === undefined ||
      !validActorId(actorId) ||
      connectionGeneration === undefined ||
      !SHORT_TOKEN_PATTERN.test(connectionGeneration) ||
      displayName === undefined ||
      !Number.isSafeInteger(sessionExpiresAt) ||
      sessionExpiresAt <= now ||
      tableId === undefined ||
      !TABLE_ID_PATTERN.test(tableId) ||
      !validInstanceId(instanceId) ||
      !Number.isSafeInteger(bindingGeneration) ||
      bindingGeneration < 1 ||
      bindingProof === undefined ||
      !TOKEN_PATTERN.test(bindingProof) ||
      !Number.isSafeInteger(sessionGeneration) ||
      sessionGeneration < 1
    ) {
      return problemResponse(
        401,
        "invalid-internal-session",
        "The table session is invalid.",
      );
    }
    const grant: ConnectionGrant = {
      actorId,
      displayName,
      instanceId,
      tableId,
      bindingGeneration,
      bindingProof,
      sessionGeneration,
      expiresAt: sessionExpiresAt,
    };
    if (!this.grantIsCurrent(grant, now)) {
      return problemResponse(
        403,
        "table-access-denied",
        "The table session is not authorized.",
      );
    }
    const publicTransition = activateTableConnection(
      new SqliteTableConnectionStore(this.ctx.storage),
      grant,
      connectionGeneration,
      {
        now,
        game: this.gameState()?.state,
        createCommandId: () => crypto.randomUUID(),
      },
    );
    const attachment: ConnectionAttachment = {
      actorId,
      connectionGeneration,
      connectionId: crypto.randomUUID(),
      sessionExpiresAt,
      version: 1,
      ...(new URL(request.url).searchParams.getAll("heartbeat").length === 1 &&
      new URL(request.url).searchParams.get("heartbeat") === "1"
        ? { heartbeatAcceptedAt: now }
        : {}),
    };
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    if (attachment.heartbeatAcceptedAt !== undefined)
      server.send(TABLE_HEARTBEAT_READY);
    reconcileTableWork(new SqliteTableConnectionStore(this.ctx.storage), {
      now,
      observations: this.presenceObservations(),
      game: this.gameState()?.state,
      connectedActorId: actorId,
      createCommandId: () => crypto.randomUUID(),
    });
    this.players.initialize(
      actorId,
      attachment.connectionId,
      this.playerView(actorId),
    );
    if (publicTransition) this.broadcastSnapshots(attachment.connectionId);
    await this.repairAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private connectionGrant(
    attachment: ConnectionAttachment,
  ): ConnectionGrant | undefined {
    const grant = new SqliteTableConnectionStore(this.ctx.storage).grant(
      attachment.connectionGeneration,
    );
    return grant?.actorId === attachment.actorId &&
      grant.expiresAt === attachment.sessionExpiresAt
      ? grant
      : undefined;
  }

  private grantAuthorityIsCurrent(grant: ConnectionGrant): boolean {
    return connectionAuthorityIsCurrent(
      new SqliteTableAccessStore(this.ctx.storage),
      grant,
    );
  }

  private grantIsCurrent(grant: ConnectionGrant, now: number): boolean {
    return this.grantAuthorityIsCurrent(grant) && grant.expiresAt > now;
  }

  public override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const now = Date.now();
    const attachment = connectionAttachment(socket.deserializeAttachment());
    const grant =
      attachment === undefined ? undefined : this.connectionGrant(attachment);
    if (
      attachment === undefined ||
      attachment.sessionExpiresAt <= now ||
      grant === undefined ||
      !this.grantIsCurrent(grant, now)
    ) {
      socket.close(1008, "Session expired, replaced, or invalid");
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
    if (parseTableResync(message) !== undefined) {
      this.players.snapshot(attachment.actorId, attachment.connectionId);
      return;
    }
    const command = parseTableCommand(message);
    if (command === undefined) {
      socket.close(1008, "Unsupported message");
      return;
    }
    const operation = await this.ctx.blockConcurrencyWhile(async () => {
      const deadlineBroadcast = await this.drainDueDeadlines(now);
      // Authorization and active source are both rechecked after asynchronous
      // deadline work, and again at the engine/commit boundary.
      const result = this.socketIsUsable(socket, Date.now())
        ? await this.players.human(
            attachment.actorId,
            attachment.connectionId,
            command,
          )
        : undefined;
      return { deadlineBroadcast, result };
    });
    if (operation.deadlineBroadcast) this.broadcastSnapshots();
    const { result } = operation;
    if (result === undefined) {
      socket.send(
        lobbyReceipt(command.commandId, "rejected", this.stateVersion(), {
          code: "inactive-controller",
          message: "Reconnect to restore human control of this player.",
        }),
      );
      return;
    }
    this.players.outcome(
      attachment.actorId,
      attachment.connectionId,
      result.response,
    );
    this.players.changed(attachment.actorId);
    const departed =
      result.applied &&
      command.command.type === "lobby/leave-seat" &&
      this.gameState() !== undefined;
    if (departed)
      socket.close(
        attachment.heartbeatAcceptedAt === undefined ? 1008 : 4002,
        "Player departed",
      );
    if (result.broadcast)
      this.broadcastSnapshots(departed ? attachment.connectionId : undefined);
    else if (!departed && (result.senderSnapshot || result.stale)) {
      this.players.snapshot(attachment.actorId, attachment.connectionId);
    }
    await this.repairAlarm();
  }

  public override webSocketError(socket: WebSocket, error: unknown): void {
    void error;
    socket.close(1011, "WebSocket error");
  }

  public override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    const attachment = connectionAttachment(socket.deserializeAttachment());
    if (attachment !== undefined) {
      const now = Date.now();
      closeTableConnection(
        new SqliteTableConnectionStore(this.ctx.storage),
        attachment.connectionGeneration,
        {
          now,
          observations: this.presenceObservations(attachment.connectionId),
          game: this.gameState()?.state,
          createCommandId: () => crypto.randomUUID(),
        },
      );
      await this.repairAlarm();
    }
  }
}
