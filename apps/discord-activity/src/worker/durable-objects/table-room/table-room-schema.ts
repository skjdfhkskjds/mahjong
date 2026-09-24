import {
  createTableRoomSchemaV1,
  validateTableRoomStorageV1,
} from "./table-room-game-store.js";

export function initializeTableRoomStorage(
  storage: DurableObjectStorage,
): void {
  const sql = storage.sql;
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
    storage.transactionSync(() => {
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
      createTableRoomSchemaV1(sql);
    });
  }
  validateTableRoomStorageV1(storage);
}
