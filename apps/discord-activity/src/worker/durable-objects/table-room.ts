import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.js";
import {
  jsonResponse,
  methodNotAllowed,
  problemResponse,
} from "../http/responses.js";

const PROTOCOL_VERSION = 1;
const STATE_VERSION = 0;
const MAX_MESSAGE_BYTES = 2_048;
const MAX_INTERNAL_BODY_BYTES = 4_096;
const CAPABILITY_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHORT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const DISPLAY_NAME_PATTERN = /^[^\p{Cc}\p{Cf}]{1,40}$/u;

const INTERNAL_ACTOR_ID = "X-Mahjong-Actor-Id";
const INTERNAL_BINDING_GENERATION = "X-Mahjong-Binding-Generation";
const INTERNAL_BINDING_PROOF = "X-Mahjong-Binding-Proof";
const INTERNAL_CONNECTION_GENERATION = "X-Mahjong-Connection-Generation";
const INTERNAL_DISPLAY_NAME = "X-Mahjong-Display-Name";
const INTERNAL_INSTANCE_ID = "X-Mahjong-Instance-Id";
const INTERNAL_SESSION_EXPIRES_AT = "X-Mahjong-Session-Expires-At";
const INTERNAL_SESSION_GENERATION = "X-Mahjong-Session-Generation";
const INTERNAL_TABLE_ID = "X-Mahjong-Table-Id";

interface Actor {
  readonly id: string;
  readonly displayName: string;
}

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
  readonly version: 1;
}

interface InvitationRedeemRequest extends BindingAuthorization {
  readonly actor: Actor;
  readonly capability: string;
  readonly now: number;
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["displayName", "id"]) ||
    !validActorId(value["id"]) ||
    typeof value["displayName"] !== "string" ||
    !DISPLAY_NAME_PATTERN.test(value["displayName"])
  ) {
    return undefined;
  }
  return { displayName: value["displayName"], id: value["id"] };
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
        "version",
      ]
    : [
        "actorId",
        "bindingGeneration",
        "bindingProof",
        "instanceId",
        "now",
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
    Math.abs((value["now"] as number) - Date.now()) > MAX_CLOCK_SKEW_MS
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
      "version",
    ]) ||
    value["version"] !== 1 ||
    typeof value["capability"] !== "string" ||
    value["capability"].length > 256 ||
    !Number.isSafeInteger(value["now"]) ||
    Math.abs((value["now"] as number) - Date.now()) > MAX_CLOCK_SKEW_MS
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

function snapshot(
  attachment: ConnectionAttachment,
  grant: ConnectionGrantRow,
): string {
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
      tableId: grant.table_id,
      viewer: {
        actor: { displayName: grant.display_name, id: attachment.actorId },
        role: "spectator",
      },
    },
  });
}

function isResyncMessage(message: string): boolean {
  try {
    const value = JSON.parse(message) as unknown;
    return (
      isRecord(value) &&
      Object.keys(value).every(
        (key) => key === "type" || key === "lastSeenStateVersion",
      ) &&
      value["type"] === "table/resync" &&
      Number.isSafeInteger(value["lastSeenStateVersion"]) &&
      (value["lastSeenStateVersion"] as number) >= 0
    );
  } catch {
    return false;
  }
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
    sql.exec(
      "CREATE TABLE IF NOT EXISTS storage_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL)",
    );
    sql.exec(
      "INSERT OR IGNORE INTO storage_metadata (singleton, schema_version) VALUES (1, 1)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS table_record (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), table_id TEXT NOT NULL UNIQUE, owner_actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, instance_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, binding_proof TEXT NOT NULL, binding_operation_id TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS members (actor_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'member')), joined_at INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS binding_receipts (operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')), response_json TEXT, http_status INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS capabilities (capability_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invitation', 'resume')), subject_actor_id TEXT NOT NULL, secret_hash TEXT NOT NULL, expected_binding_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_actor_id TEXT, consumed_operation_id TEXT)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS actor_sessions (actor_id TEXT PRIMARY KEY, session_generation INTEGER NOT NULL, activated_at INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS connection_grants (connection_generation TEXT PRIMARY KEY, actor_id TEXT NOT NULL, display_name TEXT NOT NULL, instance_id TEXT NOT NULL, table_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, binding_proof TEXT NOT NULL, session_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
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
    const requestJson = JSON.stringify(body);
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
    const result =
      body.intent.kind === "create"
        ? this.applyCreate(body, tableId)
        : await this.applyResume(body, tableId);
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

  private async applyResume(
    body: ApplyBindingRequest,
    tableId: string,
  ): Promise<StoredResult> {
    const table = this.table();
    if (table === undefined)
      return problem(404, "table-not-found", "The table does not exist.");
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
    if (body.intent.kind !== "resume") {
      return problem(
        400,
        "invalid-binding-request",
        "The binding request is invalid.",
      );
    }
    const capability = parseCapability(body.intent.capability);
    if (capability?.tableId !== tableId) {
      return problem(403, "invalid-capability", "The capability is invalid.");
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
      row.secret_hash !== (await sha256(capability.secret))
    ) {
      return problem(403, "invalid-capability", "The capability is invalid.");
    }
    if (row.expires_at <= Date.now()) {
      return problem(410, "capability-expired", "The capability has expired.");
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
    const proof = randomToken();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE table_record SET instance_id = ?, binding_generation = ?, binding_proof = ?, binding_operation_id = ? WHERE singleton = 1 AND binding_generation = ?",
        body.instanceId,
        generation,
        proof,
        body.operationId,
        table.binding_generation,
      );
      this.ctx.storage.sql.exec(
        "UPDATE capabilities SET consumed_actor_id = ?, consumed_operation_id = ? WHERE capability_id = ? AND consumed_operation_id IS NULL",
        body.actor.id,
        body.operationId,
        capability.capabilityId,
      );
    });
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
  }

  private async createCapability(
    value: unknown,
    kind: "invitation" | "resume",
  ): Promise<Response> {
    const body = parseCapabilityCreateRequest(value, kind === "invitation");
    const table = this.table();
    if (body === undefined || table === undefined) {
      return problemResponse(
        400,
        "invalid-capability-request",
        "The capability request is invalid.",
      );
    }
    if (
      !this.bindingAuthorized(body, table) ||
      table.owner_actor_id !== body.actorId
    ) {
      return problemResponse(
        403,
        "capability-not-authorized",
        "The capability request is not authorized.",
      );
    }
    const subjectActorId =
      kind === "invitation" ? body.invitedActorId : body.actorId;
    if (
      subjectActorId === undefined ||
      (kind === "invitation" && subjectActorId === table.owner_actor_id)
    ) {
      return problemResponse(
        400,
        "invalid-capability-subject",
        "The capability subject is invalid.",
      );
    }
    const capabilityId = randomCapabilityId();
    const secret = randomToken();
    const expiresAt = Date.now() + CAPABILITY_LIFETIME_MS;
    this.ctx.storage.sql.exec(
      "INSERT INTO capabilities (capability_id, kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      capabilityId,
      kind,
      subjectActorId,
      await sha256(secret),
      table.binding_generation,
      expiresAt,
    );
    return jsonResponse({
      version: 1,
      capability: `v1.${table.table_id}.${capabilityId}.${secret}`,
      expiresAt,
    });
  }

  private async redeemInvitation(value: unknown): Promise<Response> {
    const body = parseInvitationRedeemRequest(value);
    const table = this.table();
    if (body === undefined || table === undefined) {
      return problemResponse(
        400,
        "invalid-invitation-request",
        "The invitation request is invalid.",
      );
    }
    if (!this.bindingAuthorized(body, table)) {
      return problemResponse(
        409,
        "stale-binding",
        "The table binding is no longer active.",
      );
    }
    const capability = parseCapability(body.capability);
    if (capability?.tableId !== table.table_id) {
      return problemResponse(
        403,
        "invalid-capability",
        "The capability is invalid.",
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
      row.secret_hash !== (await sha256(capability.secret))
    ) {
      return problemResponse(
        403,
        "invalid-capability",
        "The capability is invalid.",
      );
    }
    if (row.expected_binding_generation !== table.binding_generation) {
      return problemResponse(
        409,
        "stale-binding-generation",
        "The table binding changed after the capability was issued.",
      );
    }
    if (row.expires_at <= body.now || row.expires_at <= Date.now()) {
      return problemResponse(
        410,
        "capability-expired",
        "The capability has expired.",
      );
    }
    if (row.consumed_actor_id !== null) {
      return problemResponse(
        410,
        "capability-consumed",
        "The capability was already used.",
      );
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'member', ?)",
        body.actor.id,
        body.actor.displayName,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE capabilities SET consumed_actor_id = ? WHERE capability_id = ? AND consumed_actor_id IS NULL",
        body.actor.id,
        capability.capabilityId,
      );
    });
    return jsonResponse({
      version: 1,
      tableId: table.table_id,
      role: "member",
    });
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
    const member = this.ctx.storage.sql
      .exec<{ actor_id: string }>(
        "SELECT actor_id FROM members WHERE actor_id = ?",
        body.actorId,
      )
      .toArray()[0];
    if (!this.bindingAuthorized(body, table)) {
      return problemResponse(
        409,
        "stale-binding",
        "The table binding is no longer active.",
      );
    }
    if (member === undefined) {
      return problemResponse(
        403,
        "session-not-authorized",
        "The session activation is not authorized.",
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
            JSON.stringify({ type: "session/replaced", protocolVersion: 1 }),
          );
          socket.close(4001, "Session replaced");
        }
      }
    }
    return jsonResponse({ version: 1, active: true });
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
    const displayName = boundedHeader(request, INTERNAL_DISPLAY_NAME, 40);
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
      !DISPLAY_NAME_PATTERN.test(displayName) ||
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
    server.send(snapshot(attachment, grant));
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

  public override webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): void {
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
    if (!isResyncMessage(message)) {
      socket.close(1008, "Unsupported message");
      return;
    }
    socket.send(snapshot(attachment, grant));
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
