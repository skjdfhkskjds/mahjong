import { DurableObject } from "cloudflare:workers";
import {
  applyGameCommandV2,
  decideReactionExpiration,
  decodeCanonicalVersionedGameJson,
  HONG_KONG_V1_RANDOM_BYTES,
  projectGameV2,
  reduceVersionedGameEvent,
  startHongKongV2Game,
  type CanonicalGameStateV2,
  type GameViewV2,
  type HongKongGameCommandV2,
  type NonEmptyGameEventBatch,
  type VersionedCanonicalGameState,
} from "@mahjong/rules-hong-kong";

import {
  automaticGameEvents,
  automaticReactionPassEvents,
  gamePlayerAt,
} from "./table-room/table-room-automation.js";
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
  completeDeadlineWithReceipt,
  earliestPendingDeadline,
  MAX_DUE_DEADLINE_BATCH,
  planAlarmRepair,
  readDueDeadlines,
  scheduleDeadline,
  verifyDeadlinePersistence,
  type PendingDeadline,
  type SystemCommandResult,
} from "./table-room/deadline-queue.js";
import {
  migrateTableRoomStorageToV4,
  persistPreparedGameBatchInTransaction,
  prepareGameEventBatch,
  prepareV1GameUpgrade,
  verifyStoredGame,
  type PreparedGameEventBatch,
} from "./table-room/table-room-game-store.js";
import {
  canonicalTableRequest,
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
  reconcilePresenceDeadlines,
  recordValidConnection,
  type PresenceObservation,
} from "./table-room/table-room-presence.js";

const MAX_MESSAGE_BYTES = 16_384;
const MAX_INTERNAL_BODY_BYTES = 4_096;
const CAPABILITY_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHORT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const TURN_DEADLINE_MS = 60_000;
const REACTION_DEADLINE_MS = 8_000;

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
}

interface ConnectionAttachment {
  readonly actorId: string;
  readonly connectionGeneration: string;
  readonly connectionId: string;
  readonly sessionExpiresAt: number;
  readonly version: 2;
}

interface ConnectionGrantRow {
  readonly [key: string]: SqlStorageValue;
  readonly actor_id: string;
  readonly binding_generation: number;
  readonly binding_proof: string;
  readonly display_name: string;
  readonly expires_at: number;
  readonly instance_id: string;
  readonly session_generation: number;
  readonly table_id: string;
}

interface TableRow {
  readonly [key: string]: SqlStorageValue;
  readonly binding_generation: number;
  readonly binding_operation_id: string;
  readonly binding_proof: string;
  readonly instance_id: string;
  readonly owner_actor_id: string;
  readonly table_id: string;
}

interface ReceiptRow {
  readonly [key: string]: SqlStorageValue;
  readonly http_status: number;
  readonly request_json: string;
  readonly response_json: string | null;
  readonly status: string;
}

interface CapabilityRow {
  readonly [key: string]: SqlStorageValue;
  readonly consumed_actor_id: string | null;
  readonly consumed_operation_id: string | null;
  readonly expected_binding_generation: number;
  readonly expires_at: number;
  readonly kind: string;
  readonly secret_hash: string;
  readonly subject_actor_id: string;
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

interface LobbyReceiptRow {
  readonly [key: string]: SqlStorageValue;
  readonly actor_id: string;
  readonly request_json: string;
  readonly response_json: string;
}

interface ViewerSafeActor {
  readonly displayName: string;
  readonly id: string;
}

interface ViewerSafeTableSnapshot {
  readonly type: "table/snapshot";
  readonly protocolVersion: 2;
  readonly stateVersion: number;
  readonly view: {
    readonly phase:
      "abandoned" | "complete" | "exhausted" | "lobby" | "playing";
    readonly game?: GameViewV2 & { readonly deadlineAt: number | null };
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
  readonly protocolVersion: 2;
  readonly commandId: string;
  readonly outcome: "applied" | "rejected";
  readonly stateVersion: number;
  readonly error?: { readonly code: string; readonly message: string };
}

interface ViewerSafeSessionReplaced {
  readonly type: "session/replaced";
  readonly protocolVersion: 2;
}

type ViewerSafeServerMessage =
  ViewerSafeTableSnapshot | ViewerSafeTableReceipt | ViewerSafeSessionReplaced;

class AtomicMutationConflict extends Error {}

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

function isGameCommand(
  command: TableCommandEnvelope["command"],
): command is HongKongGameCommandV2 {
  return command.type.startsWith("game/") && command.type !== "game/start";
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
    ]) ||
    value["version"] !== 1 ||
    !validActorId(value["actorId"]) ||
    !Number.isSafeInteger(value["sessionGeneration"]) ||
    (value["sessionGeneration"] as number) < 1
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
    ]) ||
    value["version"] !== 2 ||
    !validActorId(value["actorId"]) ||
    typeof value["connectionId"] !== "string" ||
    !SHORT_TOKEN_PATTERN.test(value["connectionId"]) ||
    typeof value["connectionGeneration"] !== "string" ||
    !SHORT_TOKEN_PATTERN.test(value["connectionGeneration"]) ||
    !Number.isSafeInteger(value["sessionExpiresAt"]) ||
    (value["sessionExpiresAt"] as number) < 0
  ) {
    return undefined;
  }
  return value as unknown as ConnectionAttachment;
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

function problem(status: number, code: string, message: string): StoredResult {
  return { body: { error: { code, message } }, status };
}

export class TableRoom extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = this.ctx.storage.sql;
    const knownTables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('storage_metadata', 'table_record', 'members', 'binding_receipts', 'capabilities', 'actor_sessions', 'connection_grants', 'lobby_state', 'lobby_seats', 'lobby_command_receipts', 'canonical_game_state', 'game_events')",
      )
      .toArray();
    const freshStorage = knownTables.length === 0;
    if (
      !freshStorage &&
      !knownTables.some(({ name }) => name === "storage_metadata")
    ) {
      throw new Error("TableRoom storage metadata is missing.");
    }
    if (freshStorage) {
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "CREATE TABLE storage_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL)",
        );
        sql.exec(
          "INSERT INTO storage_metadata (singleton, schema_version) VALUES (1, 1)",
        );
        sql.exec(
          "CREATE TABLE table_record (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), table_id TEXT NOT NULL UNIQUE, owner_actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, instance_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, binding_proof TEXT NOT NULL, binding_operation_id TEXT NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE members (actor_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'member')), joined_at INTEGER NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE binding_receipts (operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')), response_json TEXT, http_status INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE capabilities (capability_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invitation', 'resume')), subject_actor_id TEXT NOT NULL, secret_hash TEXT NOT NULL, expected_binding_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_actor_id TEXT, consumed_operation_id TEXT)",
        );
        sql.exec(
          "CREATE TABLE actor_sessions (actor_id TEXT PRIMARY KEY, session_generation INTEGER NOT NULL, activated_at INTEGER NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE connection_grants (connection_generation TEXT PRIMARY KEY, actor_id TEXT NOT NULL, display_name TEXT NOT NULL, instance_id TEXT NOT NULL, table_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, binding_proof TEXT NOT NULL, session_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
        );
      });
    }
    migrateTableRoomStorageToV4(this.ctx.storage);
    void this.ctx.blockConcurrencyWhile(async () => {
      verifyDeadlinePersistence(sql);
      let game = await verifyStoredGame(sql);
      if (game?.state.schemaVersion === 1) {
        const upgrade = await prepareV1GameUpgrade(game);
        this.ctx.storage.transactionSync(() => {
          persistPreparedGameBatchInTransaction(sql, upgrade);
        });
        game = await verifyStoredGame(sql);
      }
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        const canonical =
          game?.state.schemaVersion === 2 ? game.state : undefined;
        reconcilePresenceDeadlines(sql, {
          now,
          observations: this.presenceObservations(),
        });
        if (canonical !== undefined) {
          this.replaceGameDeadlines(sql, canonical, now);
        }
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

  private table(): TableRow | undefined {
    return this.ctx.storage.sql
      .exec<TableRow>(
        "SELECT table_id, owner_actor_id, instance_id, binding_generation, binding_proof, binding_operation_id FROM table_record WHERE singleton = 1",
      )
      .toArray()[0];
  }

  private stateVersion(): number {
    return this.ctx.storage.sql
      .exec<{ state_version: number }>(
        "SELECT state_version FROM lobby_state WHERE singleton = 1",
      )
      .one().state_version;
  }

  private gameState():
    | { readonly state: CanonicalGameStateV2; readonly lastEventHash: string }
    | undefined {
    const row = this.ctx.storage.sql
      .exec<{ state_json: string; last_event_hash: string }>(
        "SELECT state_json, last_event_hash FROM canonical_game_state WHERE singleton = 1",
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    const state = decodeCanonicalVersionedGameJson(row.state_json);
    if (state.schemaVersion !== 2) {
      throw new Error("TableRoom did not upgrade its canonical game.");
    }
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

  private automatedActorIds(): ReadonlySet<string> {
    return new Set(
      [...this.automationByActor()]
        .filter(([, autopilot]) => autopilot)
        .map(([actorId]) => actorId),
    );
  }

  private snapshot(
    attachment: ConnectionAttachment,
    grant: ConnectionGrantRow,
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
            (seat) => game.state.players[seat].actorId === attachment.actorId,
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
            : game.state.phase === "exhausted"
              ? "exhausted"
              : game.state.phase === "complete"
                ? "complete"
                : "playing",
        ...(game === undefined
          ? {}
          : {
              game: {
                ...projectGameV2(game.state, attachment.actorId),
                deadlineAt: this.gameDeadlineAt(),
              },
            }),
        seats: SEATS.map((seat) => {
          const gameActorId = game?.state.players[seat].actorId;
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
        tableId: grant.table_id,
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

  private broadcastSnapshots(): void {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = connectionAttachment(socket.deserializeAttachment());
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
      socket.send(this.snapshot(attachment, grant));
    }
  }

  private async applyTableCommand(
    actorId: string,
    envelope: TableCommandEnvelope,
    now: number,
  ): Promise<{
    readonly applied: boolean;
    readonly broadcast: boolean;
    readonly response: string;
    readonly senderSnapshot: boolean;
    readonly stale: boolean;
  }> {
    const requestJson = canonicalTableRequest(envelope);
    let preparedGame: PreparedGameEventBatch | undefined;
    let preparedRejection:
      { readonly code: string; readonly message: string } | undefined;
    if (envelope.expectedStateVersion === this.stateVersion()) {
      if (envelope.command.type === "game/start") {
        if (this.gameState() !== undefined) {
          preparedRejection = {
            code: "game-already-started",
            message: "This game has already started.",
          };
        } else {
          const rows = this.ctx.storage.sql
            .exec<LobbySeatRow>(
              "SELECT seat, actor_id, display_name, ready FROM lobby_seats",
            )
            .toArray();
          if (rows.length !== 4 || rows.some(({ ready }) => ready !== 1)) {
            preparedRejection = {
              code: "table-not-ready",
              message: "Four seated players must be ready before starting.",
            };
          } else if (!rows.some(({ actor_id }) => actor_id === actorId)) {
            preparedRejection = {
              code: "spectator-cannot-start",
              message: "Only a seated player can start the game.",
            };
          } else {
            const bySeat = new Map(rows.map((row) => [row.seat, row.actor_id]));
            const east = bySeat.get("east");
            const south = bySeat.get("south");
            const west = bySeat.get("west");
            const north = bySeat.get("north");
            if (
              east === undefined ||
              south === undefined ||
              west === undefined ||
              north === undefined
            ) {
              throw new Error("A ready table has an incomplete seat map.");
            }
            const started = startHongKongV2Game(
              { east, north, south, west },
              crypto.getRandomValues(new Uint8Array(HONG_KONG_V1_RANDOM_BYTES)),
            );
            preparedGame = await prepareGameEventBatch(undefined, [
              started.event,
            ]);
          }
        }
      } else if (isGameCommand(envelope.command)) {
        const stored = await verifyStoredGame(this.ctx.storage.sql);
        if (stored?.state.schemaVersion !== 2) {
          preparedRejection = {
            code: "game-not-started",
            message: "The game has not started.",
          };
        } else {
          const decision = applyGameCommandV2(
            stored.state,
            actorId,
            envelope.command,
          );
          if (!decision.accepted) {
            preparedRejection = decision.error;
          } else {
            if (decision.state === undefined) {
              throw new Error("Accepted game command produced no state.");
            }
            const automaticPasses = automaticReactionPassEvents(
              decision.state,
              this.automatedActorIds(),
            );
            preparedGame = await prepareGameEventBatch(
              stored,
              automaticPasses === undefined
                ? decision.events
                : [
                    decision.events[0],
                    ...decision.events.slice(1),
                    ...automaticPasses,
                  ],
            );
          }
        }
      }
    }
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<LobbyReceiptRow>(
          "SELECT actor_id, request_json, response_json FROM lobby_command_receipts WHERE command_id = ?",
          envelope.commandId,
        )
        .toArray()[0];
      if (existing !== undefined) {
        if (
          existing.actor_id === actorId &&
          existing.request_json === requestJson
        ) {
          const replay = JSON.parse(existing.response_json) as unknown;
          const stale =
            isRecord(replay) &&
            isRecord(replay["error"]) &&
            replay["error"]["code"] === "stale-state-version";
          return {
            applied: false,
            broadcast: false,
            response: existing.response_json,
            senderSnapshot: envelope.command.type === "game/react",
            stale,
          };
        }
        return {
          applied: false,
          response: lobbyReceipt(
            envelope.commandId,
            "rejected",
            this.stateVersion(),
            {
              code: "command-id-collision",
              message: "The command identifier was already used.",
            },
          ),
          broadcast: false,
          senderSnapshot: false,
          stale: false,
        };
      }

      const currentVersion = this.stateVersion();
      let applied = false;
      let publicTransition = false;
      let stale = false;
      let rejection:
        { readonly code: string; readonly message: string } | undefined;
      if (envelope.expectedStateVersion !== currentVersion) {
        stale = true;
        rejection = {
          code: "stale-state-version",
          message: "The table state changed; resynchronize and retry.",
        };
      } else if (
        envelope.command.type === "game/start" ||
        isGameCommand(envelope.command)
      ) {
        if (preparedGame === undefined) {
          rejection = preparedRejection ?? {
            code: "game-state-changed",
            message: "The game state changed; resynchronize and retry.",
          };
        } else {
          const current = this.gameState();
          const validPrevious =
            preparedGame.expectedPreviousHash === null
              ? current === undefined
              : current?.lastEventHash === preparedGame.expectedPreviousHash;
          if (!validPrevious) {
            stale = true;
            rejection = {
              code: "stale-state-version",
              message: "The table state changed; resynchronize and retry.",
            };
          } else {
            persistPreparedGameBatchInTransaction(
              this.ctx.storage.sql,
              preparedGame,
            );
            applied = true;
            publicTransition = !preparedGame.rows.every((row) => {
              const event = JSON.parse(row.eventJson) as {
                readonly type?: unknown;
              };
              return event.type === "game/reaction-intent-submitted";
            });
            if (publicTransition) {
              this.replaceGameDeadlines(
                this.ctx.storage.sql,
                preparedGame.finalState,
                now,
              );
            }
          }
        }
      } else if (this.gameState() !== undefined) {
        rejection = {
          code: "lobby-closed",
          message: "Seats and readiness are locked after the game starts.",
        };
      } else if (envelope.command.type === "lobby/claim-seat") {
        const occupied = this.ctx.storage.sql
          .exec<{ actor_id: string }>(
            "SELECT actor_id FROM lobby_seats WHERE seat = ?",
            envelope.command.seat,
          )
          .toArray()[0];
        const currentSeat = this.ctx.storage.sql
          .exec<{ seat: Seat }>(
            "SELECT seat FROM lobby_seats WHERE actor_id = ?",
            actorId,
          )
          .toArray()[0];
        if (occupied !== undefined && occupied.actor_id !== actorId) {
          rejection = {
            code: "seat-unavailable",
            message: "That seat is already occupied.",
          };
        } else if (currentSeat?.seat === envelope.command.seat) {
          rejection = {
            code: "no-state-change",
            message: "The actor already occupies that seat.",
          };
        } else {
          const member = this.ctx.storage.sql
            .exec<{ display_name: string }>(
              "SELECT display_name FROM members WHERE actor_id = ?",
              actorId,
            )
            .one();
          if (currentSeat === undefined) {
            this.ctx.storage.sql.exec(
              "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES (?, ?, ?, 0)",
              envelope.command.seat,
              actorId,
              member.display_name,
            );
          } else {
            this.ctx.storage.sql.exec(
              "UPDATE lobby_seats SET seat = ?, display_name = ?, ready = 0 WHERE actor_id = ?",
              envelope.command.seat,
              member.display_name,
              actorId,
            );
          }
          applied = true;
          publicTransition = true;
        }
      } else if (envelope.command.type === "lobby/leave-seat") {
        const currentSeat = this.ctx.storage.sql
          .exec<{ seat: Seat }>(
            "SELECT seat FROM lobby_seats WHERE actor_id = ?",
            actorId,
          )
          .toArray()[0];
        const removed = this.ctx.storage.sql.exec(
          "DELETE FROM lobby_seats WHERE actor_id = ?",
          actorId,
        );
        if (removed.rowsWritten === 1 && currentSeat !== undefined) {
          applied = true;
          publicTransition = true;
        } else {
          rejection = {
            code: "not-seated",
            message: "The actor does not occupy a seat.",
          };
        }
      } else {
        const seated = this.ctx.storage.sql
          .exec<{ ready: number }>(
            "SELECT ready FROM lobby_seats WHERE actor_id = ?",
            actorId,
          )
          .toArray()[0];
        if (seated === undefined) {
          rejection = {
            code: "not-seated",
            message: "Only a seated player can change ready state.",
          };
        } else if (seated.ready === Number(envelope.command.ready)) {
          rejection = {
            code: "no-state-change",
            message: "The requested ready state is already current.",
          };
        } else {
          this.ctx.storage.sql.exec(
            "UPDATE lobby_seats SET ready = ? WHERE actor_id = ?",
            Number(envelope.command.ready),
            actorId,
          );
          applied = true;
          publicTransition = true;
        }
      }

      if (
        applied &&
        (envelope.command.type === "lobby/claim-seat" ||
          envelope.command.type === "lobby/leave-seat")
      ) {
        reconcilePresenceDeadlines(this.ctx.storage.sql, {
          now,
          observations: this.presenceObservations(),
        });
      }
      let resultVersion = currentVersion;
      if (applied && publicTransition) {
        resultVersion += 1;
        this.ctx.storage.sql.exec(
          "UPDATE lobby_state SET state_version = ? WHERE singleton = 1",
          resultVersion,
        );
      }
      const response = lobbyReceipt(
        envelope.commandId,
        applied ? "applied" : "rejected",
        resultVersion,
        rejection,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO lobby_command_receipts (command_id, actor_id, request_json, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
        envelope.commandId,
        actorId,
        requestJson,
        response,
        now,
      );
      return {
        applied,
        broadcast: applied && publicTransition,
        response,
        senderSnapshot: applied && !publicTransition,
        stale,
      };
    });
  }

  private replaceGameDeadlines(
    sql: SqlStorage,
    state: VersionedCanonicalGameState,
    now: number,
    processingDeadlineId = "",
  ): void {
    if (state.schemaVersion !== 2) {
      sql.exec(
        "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE status = 'pending' AND kind IN ('reaction', 'turn') AND deadline_id <> ?",
        processingDeadlineId,
      );
      return;
    }
    const window = state.reactionWindow;
    if (window !== null) {
      const deadlineId = `reaction:${String(window.openingSequence)}`;
      sql.exec(
        "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE status = 'pending' AND kind IN ('reaction', 'turn') AND deadline_id <> ? AND deadline_id <> ?",
        deadlineId,
        processingDeadlineId,
      );
      const existing = sql
        .exec<{ status: string }>(
          "SELECT status FROM deadlines WHERE deadline_id = ?",
          deadlineId,
        )
        .toArray()[0];
      if (existing?.status === "pending") return;
      scheduleDeadline(sql, {
        deadlineId,
        dueAt: now + REACTION_DEADLINE_MS,
        kind: "reaction",
        payload: {
          type: "system/reaction-expired",
          openingSequence: window.openingSequence,
          windowId: window.id,
        },
        status: "pending",
        targetGeneration: window.openingSequence,
      });
      return;
    }
    if (
      state.phase !== "awaiting-dealer-discard" &&
      state.phase !== "awaiting-discard" &&
      state.phase !== "awaiting-draw"
    ) {
      sql.exec(
        "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE status = 'pending' AND kind IN ('reaction', 'turn') AND deadline_id <> ?",
        processingDeadlineId,
      );
      return;
    }
    const actorId = gamePlayerAt(state, state.turn).actorId;
    const automation = sql
      .exec<{ autopilot: number }>(
        "SELECT autopilot FROM player_automation WHERE actor_id = ?",
        actorId,
      )
      .toArray()[0];
    const deadlineId = `turn:${String(state.sequence)}`;
    sql.exec(
      "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE status = 'pending' AND kind IN ('reaction', 'turn') AND deadline_id <> ? AND deadline_id <> ?",
      deadlineId,
      processingDeadlineId,
    );
    const connected = this.hasValidSocket(actorId, now);
    if (!connected && automation?.autopilot !== 1) return;
    const dueAt = automation?.autopilot === 1 ? now : now + TURN_DEADLINE_MS;
    const existing = sql
      .exec<{ status: string }>(
        "SELECT status FROM deadlines WHERE deadline_id = ?",
        deadlineId,
      )
      .toArray()[0];
    if (existing?.status === "pending") return;
    scheduleDeadline(sql, {
      deadlineId,
      dueAt,
      kind: "turn",
      payload: {
        type: "system/turn-expired",
        openingSequence: state.sequence,
        phase: state.phase,
        seat: state.turn,
      },
      status: "pending",
      targetGeneration: state.sequence,
    });
  }

  private hasValidSocket(
    actorId: string,
    now: number,
    excludedConnectionId?: string,
  ): boolean {
    return this.presenceObservations(excludedConnectionId).some(
      (observation) =>
        observation.actorId === actorId && observation.expiresAt > now,
    );
  }

  private hasAnyValidSocket(
    now: number,
    excludedConnectionId?: string,
  ): boolean {
    return this.presenceObservations(excludedConnectionId).some(
      ({ expiresAt }) => expiresAt > now,
    );
  }

  private presenceObservations(
    excludedConnectionId?: string,
  ): readonly PresenceObservation[] {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = connectionAttachment(socket.deserializeAttachment());
      if (
        attachment === undefined ||
        attachment.connectionId === excludedConnectionId
      ) {
        return [];
      }
      const grant = this.connectionGrant(attachment);
      return grant !== undefined && this.grantAuthorityIsCurrent(grant)
        ? [{ actorId: grant.actor_id, expiresAt: grant.expires_at }]
        : [];
    });
  }

  private gameBatchIsPublic(batch: PreparedGameEventBatch): boolean {
    return !batch.rows.every((row) => {
      const value = JSON.parse(row.eventJson) as { readonly type?: unknown };
      return value.type === "game/reaction-intent-submitted";
    });
  }

  private deadlineStillTargetsCurrent(
    deadline: PendingDeadline,
    state: CanonicalGameStateV2 | undefined,
    now: number,
  ): boolean {
    const payload = deadline.payload;
    switch (payload.type) {
      case "system/reaction-expired":
        return (
          state?.reactionWindow?.id === payload.windowId &&
          state.reactionWindow.openingSequence === payload.openingSequence
        );
      case "system/turn-expired":
        return (
          state?.sequence === payload.openingSequence &&
          state.phase === payload.phase &&
          state.turn === payload.seat
        );
      case "system/disconnect-grace-expired": {
        const row = this.ctx.storage.sql
          .exec<{ connection_generation: number; autopilot: number }>(
            "SELECT connection_generation, autopilot FROM player_automation WHERE actor_id = ?",
            payload.actorId,
          )
          .toArray()[0];
        return (
          row?.connection_generation === payload.connectionGeneration &&
          row.autopilot === 0 &&
          !this.hasValidSocket(payload.actorId, now)
        );
      }
      case "system/table-abandonment-expired": {
        const lifecycle = this.roomLifecycle();
        return (
          lifecycle.roomActivityGeneration === payload.roomActivityGeneration &&
          !lifecycle.abandoned &&
          !this.hasAnyValidSocket(now)
        );
      }
    }
  }

  private async processDeadline(
    deadline: PendingDeadline,
    now: number,
  ): Promise<boolean> {
    const stored = await verifyStoredGame(this.ctx.storage.sql);
    const state = stored?.state.schemaVersion === 2 ? stored.state : undefined;
    let batch: PreparedGameEventBatch | undefined;
    if (this.deadlineStillTargetsCurrent(deadline, state, now)) {
      const payload = deadline.payload;
      let events: NonEmptyGameEventBatch | undefined;
      if (payload.type === "system/reaction-expired" && state !== undefined) {
        const decision = decideReactionExpiration(state);
        events = decision.accepted ? decision.events : undefined;
      } else if (
        payload.type === "system/turn-expired" &&
        state !== undefined
      ) {
        events = automaticGameEvents(
          state,
          gamePlayerAt(state, payload.seat).actorId,
        );
      } else if (
        payload.type === "system/disconnect-grace-expired" &&
        state !== undefined
      ) {
        events = automaticGameEvents(state, payload.actorId);
      }
      if (events !== undefined && stored !== undefined && state !== undefined) {
        let afterEvents = state;
        for (const event of events) {
          const next = reduceVersionedGameEvent(afterEvents, event);
          if (next.schemaVersion !== 2) {
            throw new Error("Automatic game work produced legacy state.");
          }
          afterEvents = next;
        }
        const automaticPasses = automaticReactionPassEvents(
          afterEvents,
          this.automatedActorIds(),
        );
        if (automaticPasses !== undefined) {
          events = [events[0], ...events.slice(1), ...automaticPasses];
        }
        batch = await prepareGameEventBatch(stored, events);
      }
    }

    const completion = completeDeadlineWithReceipt(
      this.ctx.storage,
      deadline.deadlineId,
      now,
      (sql, currentDeadline): SystemCommandResult => {
        const currentGame = this.gameState()?.state;
        if (
          !this.deadlineStillTargetsCurrent(currentDeadline, currentGame, now)
        ) {
          return { outcome: "no-op", reason: "stale-target" };
        }
        let publicTransition = false;
        if (batch !== undefined) {
          persistPreparedGameBatchInTransaction(sql, batch);
          const gamePublic = this.gameBatchIsPublic(batch);
          publicTransition ||= gamePublic;
          if (gamePublic) {
            this.replaceGameDeadlines(
              sql,
              batch.finalState,
              now,
              currentDeadline.deadlineId,
            );
          }
        }
        const payload = currentDeadline.payload;
        if (payload.type === "system/disconnect-grace-expired") {
          sql.exec(
            "UPDATE player_automation SET autopilot = 1, updated_at = ? WHERE actor_id = ? AND connection_generation = ? AND autopilot = 0",
            now,
            payload.actorId,
            payload.connectionGeneration,
          );
          publicTransition = true;
        } else if (payload.type === "system/table-abandonment-expired") {
          sql.exec(
            "UPDATE room_lifecycle SET abandoned = 1, updated_at = ? WHERE singleton = 1 AND room_activity_generation = ? AND abandoned = 0",
            now,
            payload.roomActivityGeneration,
          );
          publicTransition = true;
        }
        if (publicTransition) {
          sql.exec(
            "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
          );
        }
        return { outcome: "processed", publicTransition };
      },
    );
    return (
      !completion.replayed &&
      completion.receipt.result.outcome === "processed" &&
      completion.receipt.result.publicTransition
    );
  }

  private async drainDueDeadlines(now: number): Promise<boolean> {
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
    await this.repairAlarm();
    return broadcast;
  }

  private async repairAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const plan = planAlarmRepair(
      current,
      earliestPendingDeadline(this.ctx.storage.sql),
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

  private bindingAuthorized(
    authorization: BindingAuthorization,
    row = this.table(),
  ): row is TableRow {
    return (
      row?.instance_id === authorization.instanceId &&
      row.binding_generation === authorization.bindingGeneration &&
      row.binding_proof === authorization.bindingProof
    );
  }

  private sessionGenerationCurrent(
    actorId: string,
    sessionGeneration: number,
  ): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ session_generation: number }>(
          "SELECT session_generation FROM actor_sessions WHERE actor_id = ?",
          actorId,
        )
        .toArray()[0]?.session_generation === sessionGeneration
    );
  }

  private receipt(operationId: string): ReceiptRow | undefined {
    return this.ctx.storage.sql
      .exec<ReceiptRow>(
        "SELECT request_json, status, response_json, http_status FROM binding_receipts WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
  }

  private finishReceipt(
    operationId: string,
    status: "applied" | "rejected",
    result: StoredResult,
  ): void {
    this.ctx.storage.sql.exec(
      "UPDATE binding_receipts SET status = ?, response_json = ?, http_status = ?, updated_at = ? WHERE operation_id = ?",
      status,
      JSON.stringify(result.body),
      result.status,
      Date.now(),
      operationId,
    );
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
    const capabilitySecretHash =
      capability === undefined ? undefined : await sha256(capability.secret);
    const requestJson = JSON.stringify({
      actor: body.actor,
      deadlineAt: body.deadlineAt,
      instanceId: body.instanceId,
      intent:
        capability === undefined
          ? { kind: "create" }
          : {
              kind: "resume",
              capabilityId: capability.capabilityId,
              capabilitySecretHash,
              tableId: capability.tableId,
            },
      operationId: body.operationId,
      version: 1,
    });
    const existing = this.receipt(body.operationId);
    if (existing !== undefined) {
      if (existing.request_json !== requestJson) {
        return problemResponse(
          409,
          "operation-collision",
          "The operation identifier was already used for different input.",
        );
      }
      if (existing.status !== "pending" && existing.response_json !== null) {
        return storedResponse({
          body: JSON.parse(existing.response_json) as unknown,
          status: existing.http_status,
        });
      }
      if (
        body.deadlineAt <= Date.now() &&
        this.table()?.binding_operation_id !== body.operationId
      ) {
        const expired = problem(
          410,
          "binding-expired",
          "The pending binding operation expired before it committed.",
        );
        this.finishReceipt(body.operationId, "rejected", expired);
        return storedResponse(expired);
      }
    } else {
      if (body.deadlineAt <= Date.now()) {
        return problemResponse(
          410,
          "binding-expired",
          "The binding operation expired before it was admitted.",
        );
      }
      const now = Date.now();
      this.ctx.storage.sql.exec(
        "INSERT INTO binding_receipts (operation_id, request_json, status, response_json, http_status, created_at, updated_at) VALUES (?, ?, 'pending', NULL, 0, ?, ?)",
        body.operationId,
        requestJson,
        now,
        now,
      );
    }
    let result: StoredResult;
    if (body.intent.kind === "create") {
      result = this.applyCreate(body, tableId);
    } else if (capability !== undefined && capabilitySecretHash !== undefined) {
      result = this.applyResume(
        body,
        tableId,
        capability,
        capabilitySecretHash,
      );
    } else {
      return problemResponse(
        403,
        "invalid-capability",
        "The capability is invalid.",
      );
    }
    this.finishReceipt(
      body.operationId,
      result.status >= 200 && result.status < 300 ? "applied" : "rejected",
      result,
    );
    return storedResponse(result);
  }

  private applyCreate(
    body: ApplyBindingRequest,
    tableId: string,
  ): StoredResult {
    const existing = this.table();
    if (existing?.binding_operation_id === body.operationId) {
      return {
        body: {
          version: 1,
          tableId,
          bindingGeneration: existing.binding_generation,
          bindingProof: existing.binding_proof,
          role: "owner",
        },
        status: 200,
      };
    }
    if (existing !== undefined) {
      return problem(
        409,
        "table-already-created",
        "The table has already been created.",
      );
    }
    const proof = randomToken();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO table_record (singleton, table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id) VALUES (1, ?, ?, ?, ?, 1, ?, ?)",
        tableId,
        body.actor.id,
        now,
        body.instanceId,
        proof,
        body.operationId,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'owner', ?)",
        body.actor.id,
        body.actor.displayName,
        now,
      );
    });
    return {
      body: {
        version: 1,
        tableId,
        bindingGeneration: 1,
        bindingProof: proof,
        role: "owner",
      },
      status: 200,
    };
  }

  private applyResume(
    body: ApplyBindingRequest,
    tableId: string,
    capability: ParsedCapability,
    capabilitySecretHash: string,
  ): StoredResult {
    const proof = randomToken();
    try {
      return this.ctx.storage.transactionSync(() => {
        const table = this.table();
        if (table === undefined) {
          return problem(404, "table-not-found", "The table does not exist.");
        }
        if (table.binding_operation_id === body.operationId) {
          return {
            body: {
              version: 1,
              tableId,
              bindingGeneration: table.binding_generation,
              bindingProof: table.binding_proof,
              role: "owner",
            },
            status: 200,
          };
        }
        if (table.owner_actor_id !== body.actor.id) {
          return problem(
            403,
            "resume-not-authorized",
            "Only the table owner may resume this table.",
          );
        }
        const row = this.ctx.storage.sql
          .exec<CapabilityRow>(
            "SELECT kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id FROM capabilities WHERE capability_id = ?",
            capability.capabilityId,
          )
          .toArray()[0];
        if (
          row?.kind !== "resume" ||
          row.subject_actor_id !== body.actor.id ||
          row.secret_hash !== capabilitySecretHash
        ) {
          return problem(
            403,
            "invalid-capability",
            "The capability is invalid.",
          );
        }
        if (row.expires_at <= Date.now()) {
          return problem(
            410,
            "capability-expired",
            "The capability has expired.",
          );
        }
        if (row.consumed_operation_id !== null) {
          return problem(
            410,
            "capability-consumed",
            "The capability was already used.",
          );
        }
        if (row.expected_binding_generation !== table.binding_generation) {
          return problem(
            409,
            "stale-binding-generation",
            "The table binding changed after the capability was issued.",
          );
        }
        const generation = table.binding_generation + 1;
        const capabilityUpdate = this.ctx.storage.sql.exec(
          "UPDATE capabilities SET consumed_actor_id = ?, consumed_operation_id = ? WHERE capability_id = ? AND consumed_operation_id IS NULL AND expected_binding_generation = ?",
          body.actor.id,
          body.operationId,
          capability.capabilityId,
          table.binding_generation,
        );
        const tableUpdate = this.ctx.storage.sql.exec(
          "UPDATE table_record SET instance_id = ?, binding_generation = ?, binding_proof = ?, binding_operation_id = ? WHERE singleton = 1 AND binding_generation = ?",
          body.instanceId,
          generation,
          proof,
          body.operationId,
          table.binding_generation,
        );
        if (
          capabilityUpdate.rowsWritten !== 1 ||
          tableUpdate.rowsWritten !== 1
        ) {
          throw new AtomicMutationConflict();
        }
        this.ctx.storage.sql.exec("DELETE FROM actor_sessions");
        return {
          body: {
            version: 1,
            tableId,
            bindingGeneration: generation,
            bindingProof: proof,
            role: "owner",
          },
          status: 200,
        };
      });
    } catch (error) {
      if (error instanceof AtomicMutationConflict) {
        return problem(
          409,
          "binding-conflict",
          "The table binding changed concurrently.",
        );
      }
      throw error;
    }
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
    const expiresAt = Date.now() + CAPABILITY_LIFETIME_MS;
    const result = this.ctx.storage.transactionSync<StoredResult>(() => {
      const table = this.table();
      if (
        table === undefined ||
        !this.bindingAuthorized(body, table) ||
        table.owner_actor_id !== body.actorId
      ) {
        return problem(
          403,
          "capability-not-authorized",
          "The capability request is not authorized.",
        );
      }
      if (
        !this.sessionGenerationCurrent(body.actorId, body.sessionGeneration)
      ) {
        return problem(
          409,
          "stale-session-generation",
          "The application session is no longer current.",
        );
      }
      const subjectActorId =
        kind === "invitation" ? body.invitedActorId : body.actorId;
      if (
        subjectActorId === undefined ||
        (kind === "invitation" && subjectActorId === table.owner_actor_id)
      ) {
        return problem(
          400,
          "invalid-capability-subject",
          "The capability subject is invalid.",
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO capabilities (capability_id, kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
        capabilityId,
        kind,
        subjectActorId,
        secretHash,
        table.binding_generation,
        expiresAt,
      );
      return {
        body: {
          version: 1,
          capability: `v1.${table.table_id}.${capabilityId}.${secret}`,
          expiresAt,
        },
        status: 200,
      };
    });
    return storedResponse(result);
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
    const stateVersionBefore = this.stateVersion();
    const result = this.ctx.storage.transactionSync<StoredResult>(() => {
      const table = this.table();
      if (!this.bindingAuthorized(body, table)) {
        return problem(
          409,
          "stale-binding",
          "The table binding is no longer active.",
        );
      }
      if (capability.tableId !== table.table_id) {
        return problem(403, "invalid-capability", "The capability is invalid.");
      }
      if (
        !this.sessionGenerationCurrent(body.actor.id, body.sessionGeneration)
      ) {
        return problem(
          409,
          "stale-session-generation",
          "The application session is no longer current.",
        );
      }
      const row = this.ctx.storage.sql
        .exec<CapabilityRow>(
          "SELECT kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id FROM capabilities WHERE capability_id = ?",
          capability.capabilityId,
        )
        .toArray()[0];
      if (
        row?.kind !== "invitation" ||
        row.subject_actor_id !== body.actor.id ||
        row.secret_hash !== secretHash
      ) {
        return problem(403, "invalid-capability", "The capability is invalid.");
      }
      if (row.expected_binding_generation !== table.binding_generation) {
        return problem(
          409,
          "stale-binding-generation",
          "The table binding changed after the capability was issued.",
        );
      }
      if (row.expires_at <= body.now || row.expires_at <= Date.now()) {
        return problem(
          410,
          "capability-expired",
          "The capability has expired.",
        );
      }
      if (row.consumed_actor_id !== null) {
        return problem(
          410,
          "capability-consumed",
          "The capability was already used.",
        );
      }
      const capabilityUpdate = this.ctx.storage.sql.exec(
        "UPDATE capabilities SET consumed_actor_id = ? WHERE capability_id = ? AND consumed_actor_id IS NULL",
        body.actor.id,
        capability.capabilityId,
      );
      if (capabilityUpdate.rowsWritten !== 1) {
        throw new AtomicMutationConflict();
      }
      const existingMember = this.ctx.storage.sql
        .exec<{ actor_id: string }>(
          "SELECT actor_id FROM members WHERE actor_id = ?",
          body.actor.id,
        )
        .toArray()[0];
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'member', ?)",
        body.actor.id,
        body.actor.displayName,
        Date.now(),
      );
      if (existingMember === undefined) {
        this.ctx.storage.sql.exec(
          "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
        );
      }
      return {
        body: { version: 1, tableId: table.table_id, role: "member" },
        status: 200,
      };
    });
    if (this.stateVersion() !== stateVersionBefore) this.broadcastSnapshots();
    return storedResponse(result);
  }

  private activateSession(value: unknown): Response {
    const body = parseSessionActivateRequest(value);
    const table = this.table();
    if (body === undefined || table === undefined) {
      return problemResponse(
        400,
        "invalid-session-request",
        "The session activation request is invalid.",
      );
    }
    if (!this.bindingAuthorized(body, table)) {
      return problemResponse(
        409,
        "stale-binding",
        "The table binding is no longer active.",
      );
    }
    const activeSession = this.ctx.storage.sql
      .exec<{ session_generation: number }>(
        "SELECT session_generation FROM actor_sessions WHERE actor_id = ?",
        body.actorId,
      )
      .toArray()[0];
    if (
      activeSession !== undefined &&
      activeSession.session_generation > body.sessionGeneration
    ) {
      return problemResponse(
        409,
        "stale-session-generation",
        "A newer application session is already active.",
      );
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO actor_sessions (actor_id, session_generation, activated_at) VALUES (?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET session_generation = excluded.session_generation, activated_at = excluded.activated_at WHERE excluded.session_generation >= actor_sessions.session_generation",
      body.actorId,
      body.sessionGeneration,
      Date.now(),
    );
    if (
      activeSession === undefined ||
      activeSession.session_generation < body.sessionGeneration
    ) {
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = connectionAttachment(socket.deserializeAttachment());
        if (attachment?.actorId === body.actorId) {
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
    const member = this.ctx.storage.sql
      .exec<{ role: string }>(
        "SELECT role FROM members WHERE actor_id = ?",
        body.actorId,
      )
      .toArray()[0];
    if (member === undefined) {
      return problemResponse(
        403,
        "session-not-authorized",
        "The session activation is not authorized.",
      );
    }
    return jsonResponse({ version: 1, active: true, role: member.role });
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
    const grant: ConnectionGrantRow = {
      actor_id: actorId,
      binding_generation: bindingGeneration,
      binding_proof: bindingProof,
      display_name: displayName,
      expires_at: sessionExpiresAt,
      instance_id: instanceId,
      session_generation: sessionGeneration,
      table_id: tableId,
    };
    if (!this.grantIsCurrent(grant, now)) {
      return problemResponse(
        403,
        "table-access-denied",
        "The table session is not authorized.",
      );
    }
    const connectionTransition = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "INSERT INTO connection_grants (connection_generation, actor_id, display_name, instance_id, table_id, binding_generation, binding_proof, session_generation, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        connectionGeneration,
        actorId,
        displayName,
        instanceId,
        tableId,
        bindingGeneration,
        bindingProof,
        sessionGeneration,
        sessionExpiresAt,
      );
      const transition = recordValidConnection(sql, actorId, now);
      if (transition.publicTransition) {
        sql.exec(
          "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
        );
      }
      return transition;
    });
    const attachment: ConnectionAttachment = {
      actorId,
      connectionGeneration,
      connectionId: crypto.randomUUID(),
      sessionExpiresAt,
      version: 2,
    };
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    const game = this.gameState()?.state;
    this.ctx.storage.transactionSync(() => {
      reconcilePresenceDeadlines(this.ctx.storage.sql, {
        now,
        observations: this.presenceObservations(),
      });
      if (
        game?.reactionWindow === null &&
        gamePlayerAt(game, game.turn).actorId === actorId &&
        (game.phase === "awaiting-dealer-discard" ||
          game.phase === "awaiting-discard" ||
          game.phase === "awaiting-draw")
      ) {
        this.replaceGameDeadlines(this.ctx.storage.sql, game, now);
      }
    });
    if (connectionTransition.publicTransition) this.broadcastSnapshots();
    else server.send(this.snapshot(attachment, grant));
    await this.repairAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private connectionGrant(
    attachment: ConnectionAttachment,
  ): ConnectionGrantRow | undefined {
    const grant = this.ctx.storage.sql
      .exec<ConnectionGrantRow>(
        "SELECT actor_id, display_name, instance_id, table_id, binding_generation, binding_proof, session_generation, expires_at FROM connection_grants WHERE connection_generation = ?",
        attachment.connectionGeneration,
      )
      .toArray()[0];
    return grant?.actor_id === attachment.actorId &&
      grant.expires_at === attachment.sessionExpiresAt
      ? grant
      : undefined;
  }

  private grantAuthorityIsCurrent(grant: ConnectionGrantRow): boolean {
    const table = this.table();
    if (
      table?.table_id !== grant.table_id ||
      !this.bindingAuthorized(
        {
          bindingGeneration: grant.binding_generation,
          bindingProof: grant.binding_proof,
          instanceId: grant.instance_id,
        },
        table,
      )
    ) {
      return false;
    }
    const member = this.ctx.storage.sql
      .exec<{ actor_id: string }>(
        "SELECT actor_id FROM members WHERE actor_id = ?",
        grant.actor_id,
      )
      .toArray()[0];
    const session = this.ctx.storage.sql
      .exec<{ session_generation: number }>(
        "SELECT session_generation FROM actor_sessions WHERE actor_id = ?",
        grant.actor_id,
      )
      .toArray()[0];
    return (
      member !== undefined &&
      session?.session_generation === grant.session_generation
    );
  }

  private grantIsCurrent(grant: ConnectionGrantRow, now: number): boolean {
    return this.grantAuthorityIsCurrent(grant) && grant.expires_at > now;
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
      socket.send(this.snapshot(attachment, grant));
      return;
    }
    const command = parseTableCommand(message);
    if (command === undefined) {
      socket.close(1008, "Unsupported message");
      return;
    }
    const operation = await this.ctx.blockConcurrencyWhile(async () => {
      const deadlineBroadcast = await this.drainDueDeadlines(now);
      const result = await this.applyTableCommand(
        attachment.actorId,
        command,
        now,
      );
      return { deadlineBroadcast, result };
    });
    if (operation.deadlineBroadcast) this.broadcastSnapshots();
    const { result } = operation;
    socket.send(result.response);
    if (result.broadcast) this.broadcastSnapshots();
    else if (result.senderSnapshot || result.stale) {
      socket.send(this.snapshot(attachment, grant));
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
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        sql.exec(
          "DELETE FROM connection_grants WHERE connection_generation = ?",
          attachment.connectionGeneration,
        );
        reconcilePresenceDeadlines(sql, {
          now,
          observations: this.presenceObservations(attachment.connectionId),
        });
      });
      await this.repairAlarm();
    }
  }
}
