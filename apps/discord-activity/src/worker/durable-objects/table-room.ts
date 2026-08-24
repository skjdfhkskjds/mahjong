import { DurableObject } from "cloudflare:workers";
import {
  applyGameCommand,
  canonicalEventHashPayload,
  canonicalGameEventJson,
  canonicalGameJson,
  decodeCanonicalGameEventJson,
  decodeCanonicalGameJson,
  HONG_KONG_V1_RANDOM_BYTES,
  projectGame,
  reduceGameEvent,
  startHongKongV1Game,
  type CanonicalGameState,
  type HongKongGameCommand,
  type HongKongGameEvent,
} from "@mahjong/rules-hong-kong";

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

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 16_384;
const MAX_INTERNAL_BODY_BYTES = 4_096;
const CAPABILITY_LIFETIME_MS = 15 * 60 * 1_000;
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
type Seat = "east" | "south" | "west" | "north";

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

interface LobbyCommandEnvelope {
  readonly commandId: string;
  readonly expectedStateVersion: number;
  readonly command:
    | { readonly type: "lobby/claim-seat"; readonly seat: Seat }
    | { readonly type: "lobby/leave-seat" }
    | { readonly type: "lobby/set-ready"; readonly ready: boolean }
    | { readonly type: "game/start" }
    | HongKongGameCommand;
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

type RoomDomainEvent =
  | {
      readonly type: "room/seat-claimed";
      readonly actorId: string;
      readonly seat: Seat;
    }
  | {
      readonly type: "room/seat-moved";
      readonly actorId: string;
      readonly fromSeat: Seat;
      readonly toSeat: Seat;
    }
  | {
      readonly type: "room/seat-left";
      readonly actorId: string;
      readonly seat: Seat;
    }
  | {
      readonly type: "room/readiness-changed";
      readonly actorId: string;
      readonly ready: boolean;
    };

interface ViewerSafeActor {
  readonly displayName: string;
  readonly id: string;
}

interface ViewerSafeTableSnapshot {
  readonly type: "table/snapshot";
  readonly protocolVersion: 1;
  readonly stateVersion: number;
  readonly view: {
    readonly phase: "lobby" | "playing" | "exhausted";
    readonly game?: ReturnType<typeof projectGame>;
    readonly seats: readonly {
      readonly occupant: ViewerSafeActor | null;
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

function isResyncMessage(message: string): boolean {
  try {
    const value = JSON.parse(message) as unknown;
    return (
      isRecord(value) &&
      hasExactKeys(value, [
        "type",
        "protocolVersion",
        "lastSeenStateVersion",
      ]) &&
      value["type"] === "table/resync" &&
      value["protocolVersion"] === PROTOCOL_VERSION &&
      Number.isSafeInteger(value["lastSeenStateVersion"]) &&
      (value["lastSeenStateVersion"] as number) >= 0
    );
  } catch {
    return false;
  }
}

function parseLobbyCommand(message: string): LobbyCommandEnvelope | undefined {
  try {
    const value = JSON.parse(message) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "type",
        "protocolVersion",
        "commandId",
        "expectedStateVersion",
        "command",
      ]) ||
      value["type"] !== "table/command" ||
      value["protocolVersion"] !== PROTOCOL_VERSION ||
      typeof value["commandId"] !== "string" ||
      !SHORT_TOKEN_PATTERN.test(value["commandId"]) ||
      !Number.isSafeInteger(value["expectedStateVersion"]) ||
      (value["expectedStateVersion"] as number) < 0 ||
      !isRecord(value["command"])
    ) {
      return undefined;
    }
    const command = value["command"];
    if (
      command["type"] === "lobby/claim-seat" &&
      hasExactKeys(command, ["type", "seat"]) &&
      SEATS.includes(command["seat"] as Seat)
    ) {
      return {
        commandId: value["commandId"],
        expectedStateVersion: value["expectedStateVersion"] as number,
        command: { type: "lobby/claim-seat", seat: command["seat"] as Seat },
      };
    }
    if (
      command["type"] === "lobby/leave-seat" &&
      hasExactKeys(command, ["type"])
    ) {
      return {
        commandId: value["commandId"],
        expectedStateVersion: value["expectedStateVersion"] as number,
        command: { type: "lobby/leave-seat" },
      };
    }
    if (
      command["type"] === "lobby/set-ready" &&
      hasExactKeys(command, ["type", "ready"]) &&
      typeof command["ready"] === "boolean"
    ) {
      return {
        commandId: value["commandId"],
        expectedStateVersion: value["expectedStateVersion"] as number,
        command: { type: "lobby/set-ready", ready: command["ready"] },
      };
    }
    if (command["type"] === "game/start" && hasExactKeys(command, ["type"])) {
      return {
        commandId: value["commandId"],
        expectedStateVersion: value["expectedStateVersion"] as number,
        command: { type: "game/start" },
      };
    }
    if (command["type"] === "game/draw" && hasExactKeys(command, ["type"])) {
      return {
        commandId: value["commandId"],
        expectedStateVersion: value["expectedStateVersion"] as number,
        command: { type: "game/draw" },
      };
    }
    if (
      command["type"] === "game/discard" &&
      hasExactKeys(command, ["type", "tileId"]) &&
      Number.isSafeInteger(command["tileId"]) &&
      (command["tileId"] as number) >= 0 &&
      (command["tileId"] as number) < 144
    ) {
      return {
        commandId: value["commandId"],
        expectedStateVersion: value["expectedStateVersion"] as number,
        command: {
          type: "game/discard",
          tileId: command["tileId"] as never,
        },
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function canonicalLobbyRequest(envelope: LobbyCommandEnvelope): string {
  return JSON.stringify({
    command: envelope.command,
    commandId: envelope.commandId,
    expectedStateVersion: envelope.expectedStateVersion,
    protocolVersion: PROTOCOL_VERSION,
    type: "table/command",
  });
}

function lobbyReceipt(
  commandId: string,
  outcome: "applied" | "rejected",
  stateVersion: number,
  error?: { readonly code: string; readonly message: string },
): string {
  const message: ViewerSafeTableReceipt = {
    type: "table/receipt",
    protocolVersion: PROTOCOL_VERSION,
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    const metadata = sql
      .exec<{ schema_version: number }>(
        "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
      )
      .one();
    if (
      metadata.schema_version !== 1 &&
      metadata.schema_version !== 2 &&
      metadata.schema_version !== 3
    ) {
      throw new Error("Unsupported TableRoom storage schema version.");
    }
    sql.exec(
      "SELECT table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id FROM table_record LIMIT 0",
    );
    sql.exec(
      "SELECT actor_id, display_name, role, joined_at FROM members LIMIT 0",
    );
    sql.exec(
      "SELECT operation_id, request_json, status, response_json, http_status, created_at, updated_at FROM binding_receipts LIMIT 0",
    );
    sql.exec(
      "SELECT capability_id, kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id FROM capabilities LIMIT 0",
    );
    sql.exec(
      "SELECT actor_id, session_generation, activated_at FROM actor_sessions LIMIT 0",
    );
    sql.exec(
      "SELECT connection_generation, actor_id, display_name, instance_id, table_id, binding_generation, binding_proof, session_generation, expires_at FROM connection_grants LIMIT 0",
    );
    if (metadata.schema_version === 1) {
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "CREATE TABLE lobby_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_version INTEGER NOT NULL CHECK (state_version >= 0))",
        );
        sql.exec(
          "INSERT INTO lobby_state (singleton, state_version) VALUES (1, 0)",
        );
        sql.exec(
          "CREATE TABLE lobby_seats (seat TEXT PRIMARY KEY CHECK (seat IN ('east', 'south', 'west', 'north')), actor_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, ready INTEGER NOT NULL CHECK (ready IN (0, 1)))",
        );
        sql.exec(
          "CREATE TABLE lobby_command_receipts (command_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL)",
        );
        sql.exec(
          "UPDATE storage_metadata SET schema_version = 2 WHERE singleton = 1",
        );
      });
    } else {
      sql
        .exec<{ state_version: number }>(
          "SELECT state_version FROM lobby_state WHERE singleton = 1",
        )
        .one();
      sql.exec(
        "SELECT seat, actor_id, display_name, ready FROM lobby_seats LIMIT 0",
      );
      sql.exec(
        "SELECT command_id, actor_id, request_json, response_json, created_at FROM lobby_command_receipts LIMIT 0",
      );
    }
    const postLobbyVersion = sql
      .exec<{ schema_version: number }>(
        "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
      )
      .one().schema_version;
    if (postLobbyVersion === 2) {
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "CREATE TABLE canonical_game_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL, last_event_hash TEXT NOT NULL)",
        );
        sql.exec(
          "CREATE TABLE game_events (sequence INTEGER PRIMARY KEY CHECK (sequence >= 1), event_json TEXT NOT NULL, previous_hash TEXT, event_hash TEXT NOT NULL UNIQUE)",
        );
        sql.exec(
          "UPDATE storage_metadata SET schema_version = 3 WHERE singleton = 1",
        );
      });
    } else {
      sql.exec(
        "SELECT singleton, state_json, last_event_hash FROM canonical_game_state LIMIT 0",
      );
      sql.exec(
        "SELECT sequence, event_json, previous_hash, event_hash FROM game_events LIMIT 0",
      );
    }
    void this.ctx.blockConcurrencyWhile(async () => {
      await this.verifyPersistedGame();
    });
  }

  private async verifyPersistedGame(): Promise<void> {
    const checkpoint = this.ctx.storage.sql
      .exec<{ state_json: string; last_event_hash: string }>(
        "SELECT state_json, last_event_hash FROM canonical_game_state WHERE singleton = 1",
      )
      .toArray()[0];
    const rows = this.ctx.storage.sql
      .exec<{
        sequence: number;
        event_json: string;
        previous_hash: string | null;
        event_hash: string;
      }>(
        "SELECT sequence, event_json, previous_hash, event_hash FROM game_events ORDER BY sequence",
      )
      .toArray();
    if (checkpoint === undefined) {
      if (rows.length !== 0)
        throw new Error("Game events exist without a canonical checkpoint.");
      return;
    }
    if (rows.length === 0)
      throw new Error("Canonical game checkpoint exists without events.");
    let previousHash: string | null = null;
    let replayed: CanonicalGameState | undefined;
    for (const [index, row] of rows.entries()) {
      if (row.sequence !== index + 1 || row.previous_hash !== previousHash)
        throw new Error("Persisted game event chain is non-contiguous.");
      const event = decodeCanonicalGameEventJson(row.event_json);
      if (event.sequence !== row.sequence)
        throw new Error(
          "Persisted game event sequence does not match its row.",
        );
      const expectedHash = await sha256Hex(
        canonicalEventHashPayload(previousHash, event),
      );
      if (row.event_hash !== expectedHash)
        throw new Error("Persisted game event hash verification failed.");
      replayed = reduceGameEvent(replayed, event);
      previousHash = row.event_hash;
    }
    const checkpointState = decodeCanonicalGameJson(checkpoint.state_json);
    if (
      replayed === undefined ||
      canonicalGameJson(replayed) !== canonicalGameJson(checkpointState) ||
      checkpoint.last_event_hash !== previousHash
    ) {
      throw new Error("Canonical game checkpoint diverges from event replay.");
    }
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
    | { readonly state: CanonicalGameState; readonly lastEventHash: string }
    | undefined {
    const row = this.ctx.storage.sql
      .exec<{ state_json: string; last_event_hash: string }>(
        "SELECT state_json, last_event_hash FROM canonical_game_state WHERE singleton = 1",
      )
      .toArray()[0];
    return row === undefined
      ? undefined
      : {
          state: decodeCanonicalGameJson(row.state_json),
          lastEventHash: row.last_event_hash,
        };
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
      protocolVersion: PROTOCOL_VERSION,
      stateVersion: this.stateVersion(),
      view: {
        phase:
          game === undefined
            ? "lobby"
            : game.state.phase === "exhausted"
              ? "exhausted"
              : "playing",
        ...(game === undefined
          ? {}
          : { game: projectGame(game.state, attachment.actorId) }),
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
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = connectionAttachment(socket.deserializeAttachment());
      const grant =
        attachment === undefined ? undefined : this.connectionGrant(attachment);
      if (
        attachment === undefined ||
        grant === undefined ||
        !this.grantIsCurrent(grant)
      ) {
        socket.close(1008, "Session expired, replaced, or invalid");
        continue;
      }
      socket.send(this.snapshot(attachment, grant));
    }
  }

  private async applyLobbyCommand(
    actorId: string,
    envelope: LobbyCommandEnvelope,
  ): Promise<{
    readonly applied: boolean;
    readonly event?: RoomDomainEvent | HongKongGameEvent;
    readonly response: string;
    readonly stale: boolean;
  }> {
    const requestJson = canonicalLobbyRequest(envelope);
    let preparedGame:
      | {
          readonly event: HongKongGameEvent;
          readonly eventHash: string;
          readonly previousHash: string | null;
          readonly state: CanonicalGameState;
        }
      | undefined;
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
            const actors = Object.fromEntries(
              SEATS.map((seat) => [seat, bySeat.get(seat)]),
            ) as Record<Seat, string>;
            const started = startHongKongV1Game(
              actors,
              crypto.getRandomValues(new Uint8Array(HONG_KONG_V1_RANDOM_BYTES)),
            );
            const eventHash = await sha256Hex(
              canonicalEventHashPayload(null, started.event),
            );
            preparedGame = {
              event: started.event,
              eventHash,
              previousHash: null,
              state: started.state,
            };
          }
        }
      } else if (
        envelope.command.type === "game/draw" ||
        envelope.command.type === "game/discard"
      ) {
        const current = this.gameState();
        if (current === undefined) {
          preparedRejection = {
            code: "game-not-started",
            message: "The game has not started.",
          };
        } else {
          const decision = applyGameCommand(
            current.state,
            actorId,
            envelope.command,
          );
          if (!decision.accepted || decision.state === undefined) {
            preparedRejection = decision.accepted
              ? {
                  code: "invalid-game-transition",
                  message: "The game transition did not produce state.",
                }
              : decision.error;
          } else {
            const eventHash = await sha256Hex(
              canonicalEventHashPayload(current.lastEventHash, decision.event),
            );
            preparedGame = {
              event: decision.event,
              eventHash,
              previousHash: current.lastEventHash,
              state: decision.state,
            };
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
          return { applied: false, response: existing.response_json, stale };
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
          stale: false,
        };
      }

      const currentVersion = this.stateVersion();
      let applied = false;
      let event: RoomDomainEvent | HongKongGameEvent | undefined;
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
        envelope.command.type === "game/draw" ||
        envelope.command.type === "game/discard"
      ) {
        if (preparedGame === undefined) {
          rejection = preparedRejection ?? {
            code: "game-state-changed",
            message: "The game state changed; resynchronize and retry.",
          };
        } else {
          const current = this.gameState();
          const validPrevious =
            preparedGame.previousHash === null
              ? current === undefined
              : current?.lastEventHash === preparedGame.previousHash;
          if (!validPrevious) {
            stale = true;
            rejection = {
              code: "stale-state-version",
              message: "The table state changed; resynchronize and retry.",
            };
          } else {
            if (current === undefined) {
              this.ctx.storage.sql.exec(
                "INSERT INTO canonical_game_state (singleton, state_json, last_event_hash) VALUES (1, ?, ?)",
                canonicalGameJson(preparedGame.state),
                preparedGame.eventHash,
              );
            } else {
              this.ctx.storage.sql.exec(
                "UPDATE canonical_game_state SET state_json = ?, last_event_hash = ? WHERE singleton = 1",
                canonicalGameJson(preparedGame.state),
                preparedGame.eventHash,
              );
            }
            this.ctx.storage.sql.exec(
              "INSERT INTO game_events (sequence, event_json, previous_hash, event_hash) VALUES (?, ?, ?, ?)",
              preparedGame.event.sequence,
              canonicalGameEventJson(preparedGame.event),
              preparedGame.previousHash,
              preparedGame.eventHash,
            );
            applied = true;
            event = preparedGame.event;
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
            event = {
              type: "room/seat-claimed",
              actorId,
              seat: envelope.command.seat,
            };
          } else {
            this.ctx.storage.sql.exec(
              "UPDATE lobby_seats SET seat = ?, display_name = ?, ready = 0 WHERE actor_id = ?",
              envelope.command.seat,
              member.display_name,
              actorId,
            );
            event = {
              type: "room/seat-moved",
              actorId,
              fromSeat: currentSeat.seat,
              toSeat: envelope.command.seat,
            };
          }
          applied = true;
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
          event = {
            type: "room/seat-left",
            actorId,
            seat: currentSeat.seat,
          };
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
          event = {
            type: "room/readiness-changed",
            actorId,
            ready: envelope.command.ready,
          };
        }
      }

      let resultVersion = currentVersion;
      if (applied) {
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
        Date.now(),
      );
      return {
        applied,
        response,
        stale,
        ...(event === undefined ? {} : { event }),
      };
    });
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
              protocolVersion: 1,
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

  private connectWebSocket(request: Request): Response {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return problemResponse(
        426,
        "upgrade-required",
        "A WebSocket upgrade is required.",
        { Upgrade: "websocket" },
      );
    }
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
      sessionExpiresAt <= Date.now() ||
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
    if (!this.grantIsCurrent(grant)) {
      return problemResponse(
        403,
        "table-access-denied",
        "The table session is not authorized.",
      );
    }
    this.ctx.storage.sql.exec(
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
    server.send(this.snapshot(attachment, grant));
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

  private grantIsCurrent(grant: ConnectionGrantRow): boolean {
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
      session?.session_generation === grant.session_generation &&
      grant.expires_at > Date.now()
    );
  }

  public override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = connectionAttachment(socket.deserializeAttachment());
    const grant =
      attachment === undefined ? undefined : this.connectionGrant(attachment);
    if (
      attachment === undefined ||
      attachment.sessionExpiresAt <= Date.now() ||
      grant === undefined ||
      !this.grantIsCurrent(grant)
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
    if (isResyncMessage(message)) {
      socket.send(this.snapshot(attachment, grant));
      return;
    }
    const command = parseLobbyCommand(message);
    if (command === undefined) {
      socket.close(1008, "Unsupported message");
      return;
    }
    const result = await this.applyLobbyCommand(attachment.actorId, command);
    socket.send(result.response);
    if (result.event !== undefined) this.broadcastSnapshots();
    else if (result.stale) socket.send(this.snapshot(attachment, grant));
  }

  public override webSocketError(socket: WebSocket, error: unknown): void {
    void error;
    socket.close(1011, "WebSocket error");
  }

  public override webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    void code;
    void reason;
    void wasClean;
    const attachment = connectionAttachment(socket.deserializeAttachment());
    if (attachment !== undefined) {
      this.ctx.storage.sql.exec(
        "DELETE FROM connection_grants WHERE connection_generation = ?",
        attachment.connectionGeneration,
      );
    }
  }
}
