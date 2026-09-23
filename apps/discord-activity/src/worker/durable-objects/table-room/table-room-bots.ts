import {
  projectGameV1,
  type CanonicalGameStateV1,
  type GameViewV1,
  type HongKongGameCommandV1,
} from "@mahjong/rules-hong-kong";
import type { TableSeat } from "./table-room-protocol.js";

const BOT_ID =
  /^bot:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BOT_MOVE_DELAY_MS = 750;

/** Policy input is a single player's projection, never canonical game state. */
export function botLegalMoves(
  view: GameViewV1,
): readonly HongKongGameCommandV1[] {
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
  view: GameViewV1,
  random: number,
): HongKongGameCommandV1 | undefined {
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

/** Recovery must retain the cascades that atomically retire a bot and its work. */
export function verifyBotPersistence(sql: SqlStorage): void {
  for (const [table, parent] of [
    ["bot_players", "members"],
    ["bot_work", "bot_players"],
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
  readonly [key: string]: SqlStorageValue;
}

export function readBotWork(sql: SqlStorage): readonly BotWork[] {
  const bots = readBotIds(sql);
  const rows = sql
    .exec<BotWork>(
      "SELECT actor_id, target, command_id, due_at FROM bot_work ORDER BY due_at, actor_id",
    )
    .toArray();
  if (
    rows.some(
      (row) =>
        !bots.has(row.actor_id) ||
        !/^(turn:[0-9]+|reaction:[^\p{Cc}\p{Cf}]{1,96})$/u.test(row.target) ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(row.command_id) ||
        !Number.isSafeInteger(row.due_at) ||
        row.due_at < 0,
    )
  ) {
    throw new Error("Persisted bot work is malformed.");
  }
  return rows;
}

export function botWorkTarget(
  state: CanonicalGameStateV1,
  actorId: string,
): string | undefined {
  const view = projectGameV1(state, actorId);
  if (botLegalMoves(view).length === 0) return undefined;
  return view.reaction
    ? `reaction:${view.reaction.windowId}`
    : `turn:${String(state.sequence)}`;
}

/** Called inside the same transaction as the transition that creates work. */
export function reconcileBotWork(
  sql: SqlStorage,
  state: CanonicalGameStateV1 | undefined,
  now: number,
  abandoned: boolean,
): void {
  const existing = new Map(readBotWork(sql).map((row) => [row.actor_id, row]));
  for (const actorId of readBotIds(sql)) {
    const target =
      state && !abandoned ? botWorkTarget(state, actorId) : undefined;
    if (target === undefined) {
      sql.exec("DELETE FROM bot_work WHERE actor_id = ?", actorId);
    } else if (existing.get(actorId)?.target !== target) {
      sql.exec(
        "INSERT INTO bot_work (actor_id, target, command_id, due_at) VALUES (?, ?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET target = excluded.target, command_id = excluded.command_id, due_at = excluded.due_at",
        actorId,
        target,
        crypto.randomUUID(),
        now + BOT_MOVE_DELAY_MS,
      );
    }
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
