import {
  readControllerSnapshot,
  writeControllerWorkInTransaction,
} from "./table-controller-store.js";
import {
  readPresenceState,
  writePresenceChangesInTransaction,
} from "./table-room-presence.js";
import { writeGameDeadlineChanges } from "./table-command-store.js";
import type {
  AccessCapability,
  AccessCommit,
  AccessCommitOutcome,
  AccessReceipt,
  AccessResult,
  AccessTable,
  TableAccessStore,
} from "./table-access-application.js";

interface TableRow {
  readonly [key: string]: SqlStorageValue;
  readonly table_id: string;
  readonly owner_actor_id: string;
  readonly instance_id: string;
  readonly binding_generation: number;
  readonly binding_proof: string;
  readonly binding_operation_id: string;
}

interface CapabilityRow {
  readonly [key: string]: SqlStorageValue;
  readonly kind: string;
  readonly subject_actor_id: string;
  readonly secret_hash: string;
  readonly expected_binding_generation: number;
  readonly expires_at: number;
  readonly consumed_actor_id: string | null;
  readonly consumed_operation_id: string | null;
}

interface ReceiptRow {
  readonly [key: string]: SqlStorageValue;
  readonly request_json: string;
  readonly status: string;
  readonly response_json: string | null;
  readonly http_status: number;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function positiveGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function receiptResult(row: ReceiptRow): AccessResult | undefined {
  if (row.status === "pending") {
    if (row.response_json !== null || row.http_status !== 0)
      throw new Error("Invalid persisted pending binding receipt.");
    return undefined;
  }
  if (typeof row.response_json !== "string" || row.response_json.length > 4096)
    throw new Error("Invalid persisted binding receipt response.");
  let body: unknown;
  try {
    body = JSON.parse(row.response_json) as unknown;
  } catch {
    throw new Error("Invalid persisted binding receipt response.");
  }
  if (row.status === "applied") {
    if (
      row.http_status !== 200 ||
      !exactRecord(body, [
        "version",
        "tableId",
        "bindingGeneration",
        "bindingProof",
        "role",
      ]) ||
      body["version"] !== 1 ||
      typeof body["tableId"] !== "string" ||
      !IDENTIFIER_PATTERN.test(body["tableId"]) ||
      !positiveGeneration(body["bindingGeneration"]) ||
      typeof body["bindingProof"] !== "string" ||
      !TOKEN_PATTERN.test(body["bindingProof"]) ||
      body["role"] !== "owner"
    )
      throw new Error("Invalid persisted applied binding receipt.");
  } else if (
    !Number.isSafeInteger(row.http_status) ||
    row.http_status < 400 ||
    row.http_status > 599 ||
    !exactRecord(body, ["error"]) ||
    !exactRecord(body["error"], ["code", "message"]) ||
    !boundedText(body["error"]["code"], 128) ||
    !boundedText(body["error"]["message"], 512)
  ) {
    throw new Error("Invalid persisted rejected binding receipt.");
  }
  return { status: row.http_status, body };
}

/** Mapping and atomic writes only; the caller serializes reads through commit. */
export class SqliteTableAccessStore implements TableAccessStore {
  private readonly storage: DurableObjectStorage;

  public constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  public controllerSnapshot() {
    return readControllerSnapshot(this.storage.sql);
  }
  public presenceState() {
    return readPresenceState(this.storage.sql);
  }
  public table(): AccessTable | undefined {
    const row = this.storage.sql
      .exec<TableRow>(
        "SELECT table_id, owner_actor_id, instance_id, binding_generation, binding_proof, binding_operation_id FROM table_record WHERE singleton = 1",
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (
      typeof row.table_id !== "string" ||
      !IDENTIFIER_PATTERN.test(row.table_id) ||
      !boundedText(row.owner_actor_id, 96) ||
      !boundedText(row.instance_id, 128) ||
      !positiveGeneration(row.binding_generation) ||
      typeof row.binding_proof !== "string" ||
      !TOKEN_PATTERN.test(row.binding_proof) ||
      typeof row.binding_operation_id !== "string" ||
      !IDENTIFIER_PATTERN.test(row.binding_operation_id)
    )
      throw new Error("Invalid persisted table access record.");
    return {
      tableId: row.table_id,
      ownerActorId: row.owner_actor_id,
      instanceId: row.instance_id,
      bindingGeneration: row.binding_generation,
      bindingProof: row.binding_proof,
      bindingOperationId: row.binding_operation_id,
    };
  }

  public receipt(operationId: string): AccessReceipt | undefined {
    const row = this.storage.sql
      .exec<ReceiptRow>(
        "SELECT request_json, status, response_json, http_status FROM binding_receipts WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (
      row.status !== "pending" &&
      row.status !== "applied" &&
      row.status !== "rejected"
    )
      throw new Error("Invalid persisted binding receipt status.");
    if (
      typeof row.request_json !== "string" ||
      row.request_json.length < 1 ||
      row.request_json.length > 4096
    )
      throw new Error("Invalid persisted binding receipt request.");
    return {
      requestJson: row.request_json,
      status: row.status,
      result: receiptResult(row),
    };
  }

  public capability(capabilityId: string): AccessCapability | undefined {
    const row = this.storage.sql
      .exec<CapabilityRow>(
        "SELECT kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id FROM capabilities WHERE capability_id = ?",
        capabilityId,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (row.kind !== "resume" && row.kind !== "invitation")
      throw new Error("Invalid persisted capability kind.");
    if (
      !boundedText(row.subject_actor_id, 96) ||
      typeof row.secret_hash !== "string" ||
      !TOKEN_PATTERN.test(row.secret_hash) ||
      !positiveGeneration(row.expected_binding_generation) ||
      !Number.isSafeInteger(row.expires_at) ||
      row.expires_at < 0 ||
      (row.consumed_actor_id !== null &&
        !boundedText(row.consumed_actor_id, 96)) ||
      (row.consumed_operation_id !== null &&
        (typeof row.consumed_operation_id !== "string" ||
          !IDENTIFIER_PATTERN.test(row.consumed_operation_id)))
    )
      throw new Error("Invalid persisted capability record.");
    return {
      kind: row.kind,
      subjectActorId: row.subject_actor_id,
      secretHash: row.secret_hash,
      expectedBindingGeneration: row.expected_binding_generation,
      expiresAt: row.expires_at,
      consumedActorId: row.consumed_actor_id,
      consumedOperationId: row.consumed_operation_id,
    };
  }

  public sessionGeneration(actorId: string): number | undefined {
    const row = this.storage.sql
      .exec<{ session_generation: number }>(
        "SELECT session_generation FROM actor_sessions WHERE actor_id = ?",
        actorId,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (!positiveGeneration(row.session_generation))
      throw new Error("Invalid persisted session generation.");
    return row.session_generation;
  }

  public memberRole(actorId: string): "owner" | "member" | undefined {
    const row = this.storage.sql
      .exec<{ role: string }>(
        "SELECT role FROM members WHERE actor_id = ?",
        actorId,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (row.role !== "owner" && row.role !== "member")
      throw new Error("Invalid persisted member role.");
    return row.role;
  }

  public commit(change: AccessCommit): AccessCommitOutcome {
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      switch (change.kind) {
        case "admit-binding": {
          const inserted = sql.exec(
            "INSERT INTO binding_receipts (operation_id, request_json, status, response_json, http_status, created_at, updated_at) VALUES (?, ?, 'pending', NULL, 0, ?, ?) ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id",
            change.operationId,
            change.requestJson,
            change.now,
            change.now,
          );
          return {
            kind: inserted.toArray().length === 1 ? "committed" : "conflict",
          };
        }
        case "complete-binding": {
          const mutation = change.change;
          if (mutation.kind === "create") {
            const table = mutation.table;
            sql.exec(
              "INSERT INTO table_record (singleton, table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
              table.tableId,
              table.ownerActorId,
              change.now,
              table.instanceId,
              table.bindingGeneration,
              table.bindingProof,
              table.bindingOperationId,
            );
            sql.exec(
              "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'owner', ?)",
              mutation.actor.id,
              mutation.actor.displayName,
              change.now,
            );
          } else if (mutation.kind === "resume") {
            const table = mutation.table;
            sql.exec(
              "UPDATE capabilities SET consumed_actor_id = ?, consumed_operation_id = ? WHERE capability_id = ?",
              table.ownerActorId,
              change.operationId,
              mutation.capabilityId,
            );
            sql.exec(
              "UPDATE table_record SET instance_id = ?, binding_generation = ?, binding_proof = ?, binding_operation_id = ? WHERE singleton = 1",
              table.instanceId,
              table.bindingGeneration,
              table.bindingProof,
              table.bindingOperationId,
            );
            sql.exec("DELETE FROM actor_sessions");
          }
          sql.exec(
            "UPDATE binding_receipts SET status = ?, response_json = ?, http_status = ?, updated_at = ? WHERE operation_id = ?",
            change.status,
            JSON.stringify(change.result.body),
            change.result.status,
            change.now,
            change.operationId,
          );
          return { kind: "committed" };
        }
        case "issue-capability": {
          const capability = change.capability;
          const inserted = sql.exec(
            "INSERT INTO capabilities (capability_id, kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(capability_id) DO NOTHING RETURNING capability_id",
            change.capabilityId,
            capability.kind,
            capability.subjectActorId,
            capability.secretHash,
            capability.expectedBindingGeneration,
            capability.expiresAt,
            capability.consumedActorId,
            capability.consumedOperationId,
          );
          return {
            kind: inserted.toArray().length === 1 ? "committed" : "conflict",
          };
        }
        case "redeem-invitation":
          sql.exec(
            "UPDATE capabilities SET consumed_actor_id = ? WHERE capability_id = ?",
            change.actor.id,
            change.capabilityId,
          );
          if (change.addMember) {
            sql.exec(
              "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'member', ?)",
              change.actor.id,
              change.actor.displayName,
              change.now,
            );
            sql.exec(
              "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
            );
          }
          return { kind: "committed" };
        case "activate-session":
          sql.exec(
            "INSERT INTO actor_sessions (actor_id, session_generation, activated_at) VALUES (?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET session_generation = excluded.session_generation, activated_at = excluded.activated_at",
            change.actorId,
            change.sessionGeneration,
            change.now,
          );
          if (change.presence !== undefined)
            writePresenceChangesInTransaction(sql, change.presence);
          if (change.gameDeadlines !== undefined)
            writeGameDeadlineChanges(sql, change.gameDeadlines);
          if (change.botWork !== undefined)
            writeControllerWorkInTransaction(sql, change.botWork);
          if (change.publicTransition)
            sql.exec(
              "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
            );
          return { kind: "committed" };
      }
    });
  }
}
