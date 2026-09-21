import { tableRoomV4Schema } from "./table-room-v4-schema.js";

/** Permanent dedicated-bot schema from v5. Never update to match current storage. */
export const tableRoomV5Schema = [
  ...tableRoomV4Schema,
  "CREATE TABLE bot_players (actor_id TEXT PRIMARY KEY, policy_version TEXT NOT NULL CHECK (policy_version = 'random/v1'), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
  "CREATE TABLE bot_work (actor_id TEXT PRIMARY KEY, target TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, due_at INTEGER NOT NULL CHECK (due_at BETWEEN 0 AND 9007199254740991), FOREIGN KEY (actor_id) REFERENCES bot_players(actor_id) ON DELETE CASCADE)",
] as const;
