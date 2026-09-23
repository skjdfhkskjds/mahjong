import { tableRoomV3ActiveV1GameFixture } from "./table-room-v3-active-v1-game.js";

/** Permanent pre-bot schema copied from the released v4 migration. Never update to match current storage. */
export const tableRoomV4Schema = [
  ...tableRoomV3ActiveV1GameFixture.schema,
  "CREATE TABLE deadlines (deadline_id TEXT PRIMARY KEY CHECK (length(deadline_id) BETWEEN 1 AND 96), kind TEXT NOT NULL CHECK (kind IN ('reaction', 'turn', 'disconnect', 'abandonment')), due_at INTEGER NOT NULL CHECK (due_at BETWEEN 0 AND 9007199254740991), target_generation INTEGER NOT NULL CHECK (target_generation BETWEEN 0 AND 9007199254740991), payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 4096), status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'cancelled')), processed_at INTEGER CHECK (processed_at IS NULL OR processed_at BETWEEN 0 AND 9007199254740991))",
  "CREATE INDEX deadlines_pending_due ON deadlines (due_at, deadline_id) WHERE status = 'pending'",
  "CREATE TABLE system_command_receipts (command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 1 AND 96), request_json TEXT NOT NULL CHECK (length(request_json) BETWEEN 2 AND 4096), result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 2 AND 1024), processed_at INTEGER NOT NULL CHECK (processed_at BETWEEN 0 AND 9007199254740991), FOREIGN KEY (command_id) REFERENCES deadlines(deadline_id) ON DELETE RESTRICT)",
  "CREATE TABLE room_lifecycle (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), room_activity_generation INTEGER NOT NULL CHECK (room_activity_generation BETWEEN 0 AND 9007199254740991), abandoned INTEGER NOT NULL CHECK (abandoned IN (0, 1)), updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991))",
  "CREATE TABLE player_automation (actor_id TEXT PRIMARY KEY CHECK (length(actor_id) BETWEEN 1 AND 96), connection_generation INTEGER NOT NULL CHECK (connection_generation BETWEEN 0 AND 9007199254740991), autopilot INTEGER NOT NULL CHECK (autopilot IN (0, 1)), updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
] as const;
