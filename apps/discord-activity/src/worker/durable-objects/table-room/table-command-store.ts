import {
  readControllerSnapshot,
  writeControllerWorkInTransaction,
} from "./table-controller-store.js";
import { writeBotSeatChangeInTransaction } from "./table-bot-seat-store.js";
import { isValidApplicationActor } from "../../auth/application-session.js";
import type {
  TableSystemStore,
  PreparedSystemOperation,
} from "./table-system-application.js";
import { parseTableCommand, type TableSeat } from "./table-room-protocol.js";
import type {
  CommandReceipt,
  CommandState,
  PreparedTableCommand,
  TableCommandStore,
} from "./table-command-application.js";
import {
  readDeadlineCompletion,
  writeDeadlineCompletionInTransaction,
  scheduleDeadline,
} from "./deadline-queue.js";
import {
  persistPreparedGameBatchInTransaction,
  verifyStoredGame,
} from "./table-room-game-store.js";
import {
  readPresenceState,
  writePresenceChangesInTransaction,
} from "./table-room-presence.js";
import type { GameDeadlineChanges } from "./table-game-scheduling.js";

interface CommandReceiptRow {
  readonly [key: string]: SqlStorageValue;
  readonly actor_id: string;
  readonly request_json: string;
  readonly response_json: string;
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
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

function receiptRecord(json: unknown): Record<string, unknown> {
  if (
    typeof json !== "string" ||
    new TextEncoder().encode(json).byteLength > 16_384
  )
    throw new Error("Persisted command receipt is malformed.");
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new Error("Persisted command receipt is malformed.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Persisted command receipt is malformed.");
  return value as Record<string, unknown>;
}

/** Keep historical bytes for collisions/replay, but never replay unvalidated JSON. */
function decodeCommandReceipt(
  commandId: string,
  row: CommandReceiptRow,
): CommandReceipt {
  const request = receiptRecord(row.request_json);
  const response = receiptRecord(row.response_json);
  const protocol = request["protocolVersion"];
  // Protocol 1 used the same envelope for lobby and the draw/discard slice.
  // Normalize only a validation copy; old requests must still collide with v2.
  const parsed =
    protocol === 1 || protocol === 2
      ? parseTableCommand(JSON.stringify({ ...request, protocolVersion: 2 }))
      : undefined;
  const legacyCommand =
    parsed !== undefined &&
    [
      "lobby/claim-seat",
      "lobby/leave-seat",
      "lobby/set-ready",
      "game/start",
      "game/draw",
      "game/discard",
    ].includes(parsed.command.type);
  const error = response["error"];
  const keys = [
    "type",
    "protocolVersion",
    "commandId",
    "outcome",
    "stateVersion",
  ];
  if (error !== undefined) keys.push("error");
  if (
    !boundedText(row.actor_id, 96) ||
    JSON.stringify(request) !== row.request_json ||
    JSON.stringify(response) !== row.response_json ||
    parsed?.commandId !== commandId ||
    (protocol === 1 && !legacyCommand) ||
    !exactRecord(response, keys) ||
    response["type"] !== "table/receipt" ||
    response["protocolVersion"] !== protocol ||
    response["commandId"] !== commandId ||
    (response["outcome"] !== "applied" && response["outcome"] !== "rejected") ||
    typeof response["stateVersion"] !== "number" ||
    !Number.isSafeInteger(response["stateVersion"]) ||
    response["stateVersion"] < 0 ||
    (response["outcome"] === "applied"
      ? error !== undefined
      : !exactRecord(error, ["code", "message"]) ||
        !boundedText(error["code"], 128) ||
        !boundedText(error["message"], 512))
  ) {
    throw new Error("Persisted command receipt is malformed.");
  }
  return {
    actorId: row.actor_id,
    requestJson: row.request_json,
    response: row.response_json,
  };
}

/** Apply application-selected work without interpreting phase or presence policy. */
export function writeGameDeadlineChanges(
  sql: SqlStorage,
  changes: GameDeadlineChanges,
): void {
  for (const deadlineId of changes.cancel)
    sql.exec(
      "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE deadline_id = ?",
      deadlineId,
    );
  for (const deadline of changes.schedule) scheduleDeadline(sql, deadline);
}

export class SqliteTableCommandStore
  implements TableCommandStore, TableSystemStore
{
  private readonly storage: DurableObjectStorage;
  public constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }
  public receipt(commandId: string): CommandReceipt | undefined {
    const row = this.storage.sql
      .exec<CommandReceiptRow>(
        "SELECT actor_id, request_json, response_json FROM lobby_command_receipts WHERE command_id = ?",
        commandId,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    return decodeCommandReceipt(commandId, row);
  }
  public commandState(actorId: string): CommandState {
    const sql = this.storage.sql;
    const stateVersion = sql
      .exec<{ state_version: number }>(
        "SELECT state_version FROM lobby_state WHERE singleton = 1",
      )
      .one().state_version;
    const member = sql
      .exec<{ display_name: string }>(
        "SELECT display_name FROM members WHERE actor_id = ?",
        actorId,
      )
      .one();
    if (
      !Number.isSafeInteger(stateVersion) ||
      stateVersion < 0 ||
      !isValidApplicationActor({
        id: actorId,
        displayName: member.display_name,
      })
    )
      throw new Error("Persisted command authority is malformed.");
    return {
      ownerId: sql
        .exec<{ owner_actor_id: string }>(
          "SELECT owner_actor_id FROM table_record WHERE singleton = 1",
        )
        .toArray()[0]?.owner_actor_id,
      stateVersion,
      gameExists:
        sql
          .exec(
            "SELECT singleton FROM canonical_game_state WHERE singleton = 1",
          )
          .toArray().length !== 0,
      seats: sql
        .exec<{
          seat: TableSeat;
          actor_id: string;
          display_name: string;
          ready: number;
        }>("SELECT seat, actor_id, display_name, ready FROM lobby_seats")
        .toArray()
        .map((row) => {
          if (
            !["east", "south", "west", "north"].includes(row.seat) ||
            (row.ready !== 0 && row.ready !== 1) ||
            !isValidApplicationActor({
              id: row.actor_id,
              displayName: row.display_name,
            })
          )
            throw new Error("Persisted command seat is malformed.");
          return {
            seat: row.seat,
            actorId: row.actor_id,
            displayName: row.display_name,
            ready: row.ready === 1,
          };
        }),
      memberDisplayName: member.display_name,
      presence: readPresenceState(sql),
      controllers: this.controllerSnapshot(),
    };
  }
  public verifiedGame() {
    return verifyStoredGame(this.storage.sql);
  }
  public controllerSnapshot() {
    return readControllerSnapshot(this.storage.sql);
  }
  public deadlineCompletion(deadlineId: string) {
    return readDeadlineCompletion(this.storage.sql, deadlineId);
  }
  public presenceState() {
    return readPresenceState(this.storage.sql);
  }
  public commitSystem(change: PreparedSystemOperation): void {
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      if (change.game !== undefined)
        persistPreparedGameBatchInTransaction(sql, change.game);
      if (change.gameDeadlines !== undefined)
        writeGameDeadlineChanges(sql, change.gameDeadlines);
      if (change.presence !== undefined)
        writePresenceChangesInTransaction(sql, change.presence);
      if (change.abandonRoom)
        sql.exec(
          "UPDATE room_lifecycle SET abandoned = 1, updated_at = ? WHERE singleton = 1",
          change.now,
        );
      if (change.publicTransition)
        sql.exec(
          "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
        );
      if (change.botWork !== undefined)
        writeControllerWorkInTransaction(sql, change.botWork);
      writeDeadlineCompletionInTransaction(sql, change.completion);
    });
  }
  public commitCommand(
    change: PreparedTableCommand,
  ): ReturnType<TableCommandStore["commitCommand"]> {
    return this.storage.transactionSync(() => {
      const existing = this.receipt(change.commandId);
      if (existing !== undefined)
        return { kind: "duplicate", receipt: existing };
      const sql = this.storage.sql;
      if (change.game !== undefined)
        persistPreparedGameBatchInTransaction(sql, change.game);
      if (change.botSeatChange !== undefined)
        writeBotSeatChangeInTransaction(sql, change.botSeatChange, change.now);
      if (change.removeConnectionGeneration !== undefined)
        sql.exec(
          "DELETE FROM connection_grants WHERE connection_generation = ?",
          change.removeConnectionGeneration,
        );
      const seat = change.seatChange;
      if (seat.kind === "remove")
        sql.exec("DELETE FROM lobby_seats WHERE actor_id = ?", seat.actorId);
      else if (seat.kind === "put")
        sql.exec(
          "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES (?, ?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET seat = excluded.seat, display_name = excluded.display_name, ready = excluded.ready",
          seat.seat.seat,
          seat.seat.actorId,
          seat.seat.displayName,
          Number(seat.seat.ready),
        );
      if (change.presence !== undefined)
        writePresenceChangesInTransaction(sql, change.presence);
      if (change.gameDeadlines !== undefined)
        writeGameDeadlineChanges(sql, change.gameDeadlines);
      sql.exec(
        "UPDATE lobby_state SET state_version = ? WHERE singleton = 1",
        change.stateVersion,
      );
      if (change.botWork !== undefined)
        writeControllerWorkInTransaction(sql, change.botWork);
      sql.exec(
        "INSERT INTO lobby_command_receipts (command_id, actor_id, request_json, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
        change.commandId,
        change.receipt.actorId,
        change.receipt.requestJson,
        change.receipt.response,
        change.now,
      );
      return { kind: "committed" };
    });
  }
}
