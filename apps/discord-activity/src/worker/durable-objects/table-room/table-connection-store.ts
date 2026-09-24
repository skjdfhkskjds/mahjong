import {
  readControllerSnapshot,
  writeControllerWorkInTransaction,
} from "./table-controller-store.js";
import { isValidApplicationActor } from "../../auth/application-session.js";
import type {
  ConnectionCommit,
  ConnectionGrant,
  TableConnectionStore,
} from "./table-connection-application.js";
import {
  readPresenceState,
  writePresenceChangesInTransaction,
} from "./table-room-presence.js";
import { writeGameDeadlineChanges } from "./table-command-store.js";

interface ConnectionRow {
  readonly [key: string]: SqlStorageValue;
  readonly actor_id: string;
  readonly display_name: string;
  readonly instance_id: string;
  readonly binding_generation: number;
  readonly binding_proof: string;
  readonly expires_at: number;
  readonly session_generation: number;
  readonly table_id: string;
}
export class SqliteTableConnectionStore implements TableConnectionStore {
  private readonly storage: DurableObjectStorage;
  public constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }
  public presenceState() {
    return readPresenceState(this.storage.sql);
  }
  public controllerSnapshot() {
    return readControllerSnapshot(this.storage.sql);
  }
  public grant(connectionGeneration: string): ConnectionGrant | undefined {
    const row = this.storage.sql
      .exec<ConnectionRow>(
        "SELECT actor_id, display_name, instance_id, table_id, binding_generation, binding_proof, session_generation, expires_at FROM connection_grants WHERE connection_generation = ?",
        connectionGeneration,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    if (
      !isValidApplicationActor({
        id: row.actor_id,
        displayName: row.display_name,
      }) ||
      typeof row.instance_id !== "string" ||
      !/^[^\p{Cc}\p{Cf}]{1,128}$/u.test(row.instance_id) ||
      typeof row.table_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(row.table_id) ||
      typeof row.binding_proof !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(row.binding_proof) ||
      !Number.isSafeInteger(row.binding_generation) ||
      row.binding_generation < 1 ||
      !Number.isSafeInteger(row.session_generation) ||
      row.session_generation < 1 ||
      !Number.isSafeInteger(row.expires_at) ||
      row.expires_at < 0
    ) {
      throw new Error("Persisted connection grant is malformed.");
    }
    return {
      actorId: row.actor_id,
      displayName: row.display_name,
      instanceId: row.instance_id,
      tableId: row.table_id,
      bindingGeneration: row.binding_generation,
      bindingProof: row.binding_proof,
      sessionGeneration: row.session_generation,
      expiresAt: row.expires_at,
    };
  }
  public commitConnection(change: ConnectionCommit): void {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      if (change.kind === "connect") {
        const grant = change.grant;
        sql.exec(
          "INSERT INTO connection_grants (connection_generation, actor_id, display_name, instance_id, table_id, binding_generation, binding_proof, session_generation, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          change.connectionGeneration,
          grant.actorId,
          grant.displayName,
          grant.instanceId,
          grant.tableId,
          grant.bindingGeneration,
          grant.bindingProof,
          grant.sessionGeneration,
          grant.expiresAt,
        );
      } else if (change.kind === "disconnect")
        sql.exec(
          "DELETE FROM connection_grants WHERE connection_generation = ?",
          change.connectionGeneration,
        );
      writePresenceChangesInTransaction(sql, change.presence);
      if (change.botWork !== undefined)
        writeControllerWorkInTransaction(sql, change.botWork);
      if (change.kind === "connect" && change.publicTransition)
        sql.exec(
          "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
        );
      if (change.kind === "reconcile" && change.gameDeadlines !== undefined)
        writeGameDeadlineChanges(sql, change.gameDeadlines);
    });
  }
}
