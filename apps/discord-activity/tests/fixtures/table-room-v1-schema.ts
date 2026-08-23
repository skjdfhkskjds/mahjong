/**
 * Permanent Milestone 2 TableRoom schema fixture.
 *
 * Never edit this fixture to match a later schema. Add a new fixture when a
 * later storage version becomes the oldest supported migration root.
 */
export const tableRoomV1Schema = [
  "CREATE TABLE storage_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL)",
  "CREATE TABLE table_record (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), table_id TEXT NOT NULL UNIQUE, owner_actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, instance_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, binding_proof TEXT NOT NULL, binding_operation_id TEXT NOT NULL)",
  "CREATE TABLE members (actor_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'member')), joined_at INTEGER NOT NULL)",
  "CREATE TABLE binding_receipts (operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')), response_json TEXT, http_status INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE capabilities (capability_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invitation', 'resume')), subject_actor_id TEXT NOT NULL, secret_hash TEXT NOT NULL, expected_binding_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_actor_id TEXT, consumed_operation_id TEXT)",
  "CREATE TABLE actor_sessions (actor_id TEXT PRIMARY KEY, session_generation INTEGER NOT NULL, activated_at INTEGER NOT NULL)",
  "CREATE TABLE connection_grants (connection_generation TEXT PRIMARY KEY, actor_id TEXT NOT NULL, display_name TEXT NOT NULL, instance_id TEXT NOT NULL, table_id TEXT NOT NULL, binding_generation INTEGER NOT NULL, binding_proof TEXT NOT NULL, session_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
] as const;
