export {
  botLegalMoves,
  chooseBotMove,
  botWorkTarget,
} from "./table-bot-policy.js";
import { isValidApplicationActor } from "../../auth/application-session.js";
import type { PlayerControl } from "./table-player-control.js";

const BOT_ID =
  /^bot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function createBotTables(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE bot_players (actor_id TEXT PRIMARY KEY, policy_version TEXT NOT NULL CHECK (policy_version = 'random/v1'), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
  );
  sql.exec(
    "CREATE TABLE bot_work (actor_id TEXT PRIMARY KEY, target TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, due_at INTEGER NOT NULL CHECK (due_at BETWEEN 0 AND 9007199254740991), controller_generation INTEGER NOT NULL CHECK (controller_generation BETWEEN 0 AND 9007199254740991), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
  );
}

function verifyBotForeignKeys(sql: SqlStorage): void {
  for (const [table, parent] of [
    ["bot_players", "members"],
    ["bot_work", "members"],
  ] as const) {
    const keys = sql
      .exec<{
        from: string;
        table: string;
        to: string;
        on_delete: string;
      }>(`PRAGMA foreign_key_list(${table})`)
      .toArray();
    if (
      !keys.some(
        (key) =>
          key.from === "actor_id" &&
          key.table === parent &&
          key.to === "actor_id" &&
          key.on_delete === "CASCADE",
      )
    ) {
      throw new Error("TableRoom schema-v1 bot foreign keys are missing.");
    }
  }
}

/** Recovery must retain the cascades that atomically retire a player and its work. */
export function verifyBotPersistence(sql: SqlStorage): void {
  verifyBotForeignKeys(sql);
  const generation = sql
    .exec<{ name: string; type: string; notnull: number }>(
      "PRAGMA table_info(bot_work)",
    )
    .toArray()
    .find((column) => column.name === "controller_generation");
  if (generation?.type !== "INTEGER" || generation.notnull !== 1) {
    throw new Error("TableRoom schema-v1 controller generation is missing.");
  }
  readBotWork(sql);
}

export function readBotIds(sql: SqlStorage): ReadonlySet<string> {
  const rows = sql
    .exec<{ actor_id: string; policy_version: string; seated: string | null }>(
      "SELECT b.actor_id, b.policy_version, s.actor_id AS seated FROM bot_players b LEFT JOIN lobby_seats s ON s.actor_id = b.actor_id ORDER BY b.actor_id",
    )
    .toArray();
  if (
    rows.length > 3 ||
    rows.some(
      (row) =>
        !BOT_ID.test(row.actor_id) ||
        row.policy_version !== "random/v1" ||
        row.seated !== row.actor_id,
    )
  ) {
    throw new Error("Persisted bot players are malformed.");
  }
  return new Set(rows.map(({ actor_id }) => actor_id));
}

export interface BotWork {
  readonly actor_id: string;
  readonly target: string;
  readonly command_id: string;
  readonly due_at: number;
  readonly controller_generation: number;
  readonly [key: string]: SqlStorageValue;
}

export function readBotWork(sql: SqlStorage): readonly BotWork[] {
  const players = new Set(
    readPlayerControls(sql).map(({ actorId }) => actorId),
  );
  const rows = sql
    .exec<BotWork>(
      "SELECT actor_id, target, command_id, due_at, controller_generation FROM bot_work ORDER BY due_at, actor_id",
    )
    .toArray();
  if (
    rows.some(
      (row) =>
        !players.has(row.actor_id) ||
        !/^(turn:[0-9]+|reaction:[^\p{Cc}\p{Cf}]{1,96})$/u.test(row.target) ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(row.command_id) ||
        !Number.isSafeInteger(row.due_at) ||
        row.due_at < 0 ||
        !Number.isSafeInteger(row.controller_generation) ||
        row.controller_generation < 0,
    )
  ) {
    throw new Error("Persisted bot work is malformed.");
  }
  return rows;
}

export function readPlayerControls(sql: SqlStorage): readonly PlayerControl[] {
  const bots = readBotIds(sql);
  const rows = sql
    .exec<{
      actor_id: string;
      member_id: string | null;
      display_name: string | null;
      connection_generation: number | null;
      autopilot: number | null;
    }>(
      "SELECT s.actor_id, m.actor_id AS member_id, m.display_name, a.connection_generation, a.autopilot FROM lobby_seats s LEFT JOIN members m ON m.actor_id = s.actor_id LEFT JOIN player_automation a ON a.actor_id = s.actor_id ORDER BY s.actor_id",
    )
    .toArray();
  return rows.map((row) => {
    if (
      row.member_id !== row.actor_id ||
      !isValidApplicationActor({
        id: row.actor_id,
        displayName: row.display_name,
      }) ||
      (row.connection_generation !== null &&
        (!Number.isSafeInteger(row.connection_generation) ||
          row.connection_generation < 0)) ||
      (row.autopilot !== null && row.autopilot !== 0 && row.autopilot !== 1) ||
      (row.connection_generation === null) !== (row.autopilot === null)
    ) {
      throw new Error("Persisted player controllers are malformed.");
    }
    const bot = bots.has(row.actor_id);
    return {
      actorId: row.actor_id,
      kind: bot ? "BOT" : "HUMAN",
      controller: bot || row.autopilot === 1 ? "BOT" : "HUMAN",
      generation: bot ? 0 : (row.connection_generation ?? 0),
    };
  });
}
