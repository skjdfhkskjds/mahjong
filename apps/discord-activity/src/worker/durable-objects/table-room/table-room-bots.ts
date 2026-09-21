import {
  projectGameV2,
  type CanonicalGameStateV2,
  type GameViewV2,
  type HongKongGameCommandV2,
} from "@mahjong/rules-hong-kong";
import { prepareBotWork } from "./table-bot-work.js";
import type { TableSeat } from "./table-room-protocol.js";
import { isValidApplicationActor } from "../../auth/application-session.js";
import type { PlayerControl } from "./table-player-control.js";

const BOT_ID =
  /^bot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Policy input is a single player's projection, never canonical game state. */
export function botLegalMoves(
  view: GameViewV2,
): readonly HongKongGameCommandV2[] {
  if (view.phase === "complete" || view.phase === "exhausted") return [];
  const reaction = view.viewerActions?.reaction;
  if (reaction) {
    return reaction.status === "open"
      ? reaction.actions.map((response) => ({
          type: "game/react",
          windowId: reaction.windowId,
          response,
        }))
      : [];
  }
  return view.viewerActions?.self ?? [];
}

export function chooseBotMove(
  view: GameViewV2,
  random: number,
): HongKongGameCommandV2 | undefined {
  if (!Number.isFinite(random) || random < 0 || random >= 1)
    throw new Error("Invalid bot randomness.");
  const actions = botLegalMoves(view);
  return actions[Math.floor(random * actions.length)];
}

export function createBotTables(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE bot_players (actor_id TEXT PRIMARY KEY, policy_version TEXT NOT NULL CHECK (policy_version = 'random/v1'), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
  );
  sql.exec(
    "CREATE TABLE bot_work (actor_id TEXT PRIMARY KEY, target TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, due_at INTEGER NOT NULL CHECK (due_at BETWEEN 0 AND 9007199254740991), FOREIGN KEY (actor_id) REFERENCES bot_players(actor_id) ON DELETE CASCADE)",
  );
}

function verifyBotForeignKeys(sql: SqlStorage, version: 5 | 6): void {
  for (const [table, parent] of [
    ["bot_players", "members"],
    ["bot_work", version === 5 ? "bot_players" : "members"],
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
      throw new Error(
        `TableRoom schema-v${String(version)} bot foreign keys are missing.`,
      );
    }
  }
}

/** Runs inside the schema migration transaction; v5 jobs belonged only to dedicated bots. */
export function migrateBotWorkToV6(sql: SqlStorage): void {
  verifyBotForeignKeys(sql, 5);
  readBotIds(sql);
  if (sql.exec("PRAGMA foreign_key_check").toArray().length !== 0)
    throw new Error("TableRoom schema-v5 foreign keys are violated.");
  sql.exec("ALTER TABLE bot_work RENAME TO bot_work_v5");
  sql.exec(
    "CREATE TABLE bot_work (actor_id TEXT PRIMARY KEY, target TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, due_at INTEGER NOT NULL CHECK (due_at BETWEEN 0 AND 9007199254740991), controller_generation INTEGER NOT NULL CHECK (controller_generation BETWEEN 0 AND 9007199254740991), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
  );
  sql.exec(
    "INSERT INTO bot_work (actor_id, target, command_id, due_at, controller_generation) SELECT actor_id, target, command_id, due_at, 0 FROM bot_work_v5",
  );
  sql.exec("DROP TABLE bot_work_v5");
}

/** Recovery must retain the cascades that atomically retire a player and its work. */
export function verifyBotPersistence(sql: SqlStorage): void {
  verifyBotForeignKeys(sql, 6);
  const generation = sql
    .exec<{ name: string; type: string; notnull: number }>(
      "PRAGMA table_info(bot_work)",
    )
    .toArray()
    .find((column) => column.name === "controller_generation");
  if (generation?.type !== "INTEGER" || generation.notnull !== 1) {
    throw new Error("TableRoom schema-v6 controller generation is missing.");
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

export function botWorkTarget(
  state: CanonicalGameStateV2,
  actorId: string,
): string | undefined {
  const view = projectGameV2(state, actorId);
  if (botLegalMoves(view).length === 0) return undefined;
  return view.reaction
    ? `reaction:${view.reaction.windowId}`
    : `turn:${String(state.sequence)}`;
}

/** Called inside the same transaction as the transition that creates work. */
export function reconcileBotWork(
  sql: SqlStorage,
  state: CanonicalGameStateV2 | undefined,
  now: number,
  abandoned: boolean,
): void {
  const changes = prepareBotWork({
    players: readPlayerControls(sql).map((control) => ({
      control,
      target:
        state === undefined ? undefined : botWorkTarget(state, control.actorId),
    })),
    jobs: readBotWork(sql).map((job) => ({
      actorId: job.actor_id,
      target: job.target,
      commandId: job.command_id,
      dueAt: job.due_at,
      controllerGeneration: job.controller_generation,
    })),
    now,
    abandoned,
    createCommandId: () => crypto.randomUUID(),
  });
  for (const actorId of changes.cancelActorIds)
    sql.exec("DELETE FROM bot_work WHERE actor_id = ?", actorId);
  for (const job of changes.upsert) {
    sql.exec(
      "INSERT INTO bot_work (actor_id, target, command_id, due_at, controller_generation) VALUES (?, ?, ?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET target = excluded.target, command_id = excluded.command_id, due_at = excluded.due_at, controller_generation = excluded.controller_generation",
      job.actorId,
      job.target,
      job.commandId,
      job.dueAt,
      job.controllerGeneration,
    );
  }
}

export function changeBotSeat(
  sql: SqlStorage,
  input: {
    readonly actorId: string;
    readonly ownerId: string | undefined;
    readonly seat: TableSeat;
    readonly type: "lobby/add-bot" | "lobby/remove-bot";
    readonly now: number;
  },
): { readonly code: string; readonly message: string } | undefined {
  if (input.actorId !== input.ownerId)
    return {
      code: "owner-required",
      message: "Only the table owner can manage bots.",
    };
  const seated = sql
    .exec<{ actor_id: string }>(
      "SELECT actor_id FROM lobby_seats WHERE actor_id = ?",
      input.actorId,
    )
    .toArray()[0];
  if (!seated)
    return {
      code: "owner-must-be-seated",
      message: "Claim a seat before managing bots.",
    };
  const occupant = sql
    .exec<{ actor_id: string }>(
      "SELECT actor_id FROM lobby_seats WHERE seat = ?",
      input.seat,
    )
    .toArray()[0];
  const bots = readBotIds(sql);
  if (input.type === "lobby/add-bot") {
    if (occupant || bots.size >= 3)
      return {
        code: "seat-unavailable",
        message: "Choose an empty seat for the bot.",
      };
    const actorId = `bot:${crypto.randomUUID()}`;
    const name = `Bot ${input.seat[0]?.toUpperCase() ?? ""}${input.seat.slice(1)}`;
    sql.exec(
      "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'member', ?)",
      actorId,
      name,
      input.now,
    );
    sql.exec(
      "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES (?, ?, ?, 1)",
      input.seat,
      actorId,
      name,
    );
    sql.exec(
      "INSERT INTO bot_players (actor_id, policy_version) VALUES (?, 'random/v1')",
      actorId,
    );
  } else {
    if (!occupant || !bots.has(occupant.actor_id))
      return {
        code: "bot-required",
        message: "That seat does not contain a bot.",
      };
    sql.exec("DELETE FROM lobby_seats WHERE actor_id = ?", occupant.actor_id);
    sql.exec("DELETE FROM members WHERE actor_id = ?", occupant.actor_id);
  }
  return undefined;
}
