import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { startHongKongV1Game } from "@mahjong/rules-hong-kong";
import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import { scheduleDeadline } from "../../src/worker/durable-objects/table-room/deadline-queue.js";
import type { PreparedTableCommand } from "../../src/worker/durable-objects/table-room/table-command-application.js";
import { SqliteTableCommandStore } from "../../src/worker/durable-objects/table-room/table-command-store.js";
import type { ConnectionCommit } from "../../src/worker/durable-objects/table-room/table-connection-application.js";
import { SqliteTableConnectionStore } from "../../src/worker/durable-objects/table-room/table-connection-store.js";
import type { PendingDeadline } from "../../src/worker/durable-objects/table-room/table-deadline-application.js";
import { prepareGameEventBatch } from "../../src/worker/durable-objects/table-room/table-game-events.js";
import {
  persistPreparedGameBatch,
  verifyStoredGame,
} from "../../src/worker/durable-objects/table-room/table-room-game-store.js";
import { processTableDeadline } from "../../src/worker/durable-objects/table-room/table-system-application.js";
import { tableGameDeadline } from "../../src/worker/durable-objects/table-room/table-room-game-engine.js";

const BOT_ACTOR = "bot:00000000-0000-0000-0000-000000000001";

function tableRoom(): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(`controller-commit-${crypto.randomUUID()}`);
}

function initialize(sql: SqlStorage): void {
  // Operation adapter fixture, independent of the constructor's migration root.
  // These are the v1 tables, including work for a substituted human member.
  sql.exec("DROP TABLE IF EXISTS bot_work");
  sql.exec("DROP TABLE IF EXISTS bot_players");
  sql.exec(
    "CREATE TABLE bot_players (actor_id TEXT PRIMARY KEY, policy_version TEXT NOT NULL CHECK (policy_version = 'random/v1'), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
  );
  sql.exec(
    "CREATE TABLE bot_work (actor_id TEXT PRIMARY KEY, target TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, due_at INTEGER NOT NULL CHECK (due_at BETWEEN 0 AND 9007199254740991), controller_generation INTEGER NOT NULL CHECK (controller_generation BETWEEN 0 AND 9007199254740991), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
  );
  for (const seat of ["east", "south", "west", "north"])
    sql.exec(
      "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, ?, 100)",
      `actor:${seat}`,
      seat,
      seat === "east" ? "owner" : "member",
    );
}

function snapshot(sql: SqlStorage) {
  return {
    members: sql.exec("SELECT * FROM members ORDER BY actor_id").toArray(),
    seats: sql.exec("SELECT * FROM lobby_seats ORDER BY seat").toArray(),
    bots: sql.exec("SELECT * FROM bot_players ORDER BY actor_id").toArray(),
    work: sql.exec("SELECT * FROM bot_work ORDER BY actor_id").toArray(),
    events: sql.exec("SELECT * FROM game_events ORDER BY sequence").toArray(),
    checkpoint: sql.exec("SELECT * FROM canonical_game_state").toArray(),
    receipts: sql
      .exec("SELECT * FROM lobby_command_receipts ORDER BY command_id")
      .toArray(),
    systemReceipts: sql
      .exec("SELECT * FROM system_command_receipts ORDER BY command_id")
      .toArray(),
    deadlines: sql
      .exec("SELECT * FROM deadlines ORDER BY deadline_id")
      .toArray(),
    automation: sql
      .exec("SELECT * FROM player_automation ORDER BY actor_id")
      .toArray(),
    grants: sql
      .exec("SELECT * FROM connection_grants ORDER BY connection_generation")
      .toArray(),
    version: sql.exec("SELECT * FROM lobby_state").toArray(),
    lifecycle: sql.exec("SELECT * FROM room_lifecycle").toArray(),
  };
}

describe("controller work operation commits", () => {
  it("rolls back bot membership, seating, queued work, and revision on command receipt failure", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const sql = state.storage.sql;
      initialize(sql);
      const store = new SqliteTableCommandStore(state.storage);
      const change: PreparedTableCommand = {
        commandId: "add-bot",
        receipt: {
          actorId: "actor:east",
          requestJson: JSON.stringify({
            command: { type: "lobby/add-bot", seat: "south" },
            commandId: "add-bot",
            expectedStateVersion: 0,
            protocolVersion: 1,
            type: "table/command",
          }),
          response: JSON.stringify({
            type: "table/receipt",
            protocolVersion: 1,
            commandId: "add-bot",
            outcome: "applied",
            stateVersion: 1,
          }),
        },
        now: 1_000,
        stateVersion: 1,
        seatChange: { kind: "none" },
        botSeatChange: {
          kind: "add",
          seat: {
            actorId: BOT_ACTOR,
            displayName: "Bot South",
            seat: "south",
            ready: true,
          },
        },
        botWork: {
          cancelActorIds: [],
          upsert: [
            {
              actorId: BOT_ACTOR,
              target: "turn:1",
              commandId: "bot-turn",
              dueAt: 1_750,
              controllerGeneration: 0,
            },
          ],
        },
        game: undefined,
        gameDeadlines: undefined,
        presence: undefined,
      };
      const before = snapshot(sql);
      sql.exec(
        "CREATE TRIGGER fail_controller_receipt BEFORE INSERT ON lobby_command_receipts BEGIN SELECT RAISE(ABORT, 'injected controller receipt failure'); END",
      );
      expect(() => store.commitCommand(change)).toThrow(
        "injected controller receipt failure",
      );
      expect(snapshot(sql)).toEqual(before);
      sql.exec("DROP TRIGGER fail_controller_receipt");
      expect(store.commitCommand(change)).toEqual({ kind: "committed" });
      expect(sql.exec("SELECT actor_id FROM bot_players").toArray()).toEqual([
        { actor_id: BOT_ACTOR },
      ]);
      expect(
        sql.exec("SELECT actor_id, ready FROM lobby_seats").toArray(),
      ).toEqual([{ actor_id: BOT_ACTOR, ready: 1 }]);
      expect(
        sql.exec("SELECT actor_id, command_id FROM bot_work").toArray(),
      ).toEqual([{ actor_id: BOT_ACTOR, command_id: "bot-turn" }]);
      expect(sql.exec("SELECT state_version FROM lobby_state").one()).toEqual({
        state_version: 1,
      });
    });
  });

  it("rolls back grace controller handoff, turn cancellation, job replacement, and system receipt together", async () => {
    await runInDurableObject(tableRoom(), async (_instance, state) => {
      const sql = state.storage.sql;
      initialize(sql);
      const started = startHongKongV1Game(
        {
          east: "actor:east",
          south: "actor:south",
          west: "actor:west",
          north: "actor:north",
        },
        Uint8Array.from(
          { length: 1_028 },
          (_, index) => (index * 41 + 17) & 0xff,
        ),
      );
      persistPreparedGameBatch(
        state.storage,
        await prepareGameEventBatch(undefined, [started.event]),
      );
      const stored = await verifyStoredGame(sql);
      if (stored?.state.schemaVersion !== 1)
        throw new Error("Missing game fixture.");
      const target = tableGameDeadline(stored.state);
      if (target?.kind !== "turn") throw new Error("Expected turn target.");
      const actorId = target.actorId;
      sql.exec(
        "INSERT INTO lobby_seats VALUES ('east', ?, 'Player', 1)",
        actorId,
      );
      sql.exec("INSERT INTO player_automation VALUES (?, 1, 0, 100)", actorId);
      sql.exec(
        "INSERT INTO bot_work VALUES (?, 'turn:1', 'old-job', 750, 0)",
        actorId,
      );
      scheduleDeadline(sql, {
        deadlineId: target.deadlineId,
        dueAt: 60_000,
        kind: target.kind,
        payload: target.payload,
        status: "pending",
        targetGeneration: target.targetGeneration,
      });
      const deadline: PendingDeadline = {
        deadlineId: "disconnect:1",
        dueAt: 1_000,
        kind: "disconnect",
        status: "pending",
        targetGeneration: 1,
        payload: {
          type: "system/disconnect-grace-expired",
          actorId,
          connectionGeneration: 1,
        },
      };
      scheduleDeadline(sql, deadline);
      const store = new SqliteTableCommandStore(state.storage);
      const options = {
        desiredBotActorIds: new Set([actorId]),
        createCommandId: () => "replacement-job",
      };
      const before = snapshot(sql);
      sql.exec(
        "CREATE TRIGGER fail_controller_system BEFORE INSERT ON system_command_receipts BEGIN SELECT RAISE(ABORT, 'injected controller system failure'); END",
      );
      await expect(
        processTableDeadline(store, deadline.deadlineId, 1_000, [], options),
      ).rejects.toThrow("injected controller system failure");
      expect(snapshot(sql)).toEqual(before);
      sql.exec("DROP TRIGGER fail_controller_system");
      expect(
        await processTableDeadline(
          store,
          deadline.deadlineId,
          1_000,
          [],
          options,
        ),
      ).toBe(true);
      await expect(verifyStoredGame(sql)).resolves.toEqual(stored);
      expect(
        sql
          .exec(
            "SELECT autopilot, connection_generation FROM player_automation",
          )
          .one(),
      ).toEqual({ autopilot: 1, connection_generation: 2 });
      expect(
        sql
          .exec(
            "SELECT command_id, controller_generation, due_at FROM bot_work",
          )
          .one(),
      ).toEqual({
        command_id: "replacement-job",
        controller_generation: 2,
        due_at: 1_750,
      });
      expect(
        store.deadlineCompletion(deadline.deadlineId).receipt?.result,
      ).toEqual({ outcome: "processed", publicTransition: true });
      expect(store.deadlineCompletion(target.deadlineId).deadline?.status).toBe(
        "cancelled",
      );
      const committed = snapshot(sql);
      expect(
        await processTableDeadline(
          store,
          deadline.deadlineId,
          1_001,
          [],
          options,
        ),
      ).toBe(false);
      expect(snapshot(sql)).toEqual(committed);
    });
  });

  it("rolls back restored human control, job cancellation, and connection grant when the reconnect revision fails", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const sql = state.storage.sql;
      initialize(sql);
      sql.exec(
        "INSERT INTO player_automation VALUES ('actor:east', 1, 1, 100)",
      );
      sql.exec(
        "INSERT INTO bot_work VALUES ('actor:east', 'turn:1', 'substitute-job', 750, 1)",
      );
      const change: ConnectionCommit = {
        kind: "connect",
        connectionGeneration: "new-connection",
        publicTransition: true,
        grant: {
          actorId: "actor:east",
          displayName: "East",
          tableId: "controller-table",
          instanceId: "instance",
          bindingGeneration: 1,
          bindingProof: "P".repeat(43),
          sessionGeneration: 1,
          expiresAt: 60_000,
        },
        presence: {
          automation: [
            {
              type: "upsert",
              automation: {
                actorId: "actor:east",
                connectionGeneration: 2,
                autopilot: false,
              },
            },
          ],
          deadlineCancellations: [],
          deadlineReschedules: [],
          deadlineSchedules: [],
          lifecycle: { abandoned: false, roomActivityGeneration: 1 },
          updatedAt: 1_000,
        },
        botWork: { cancelActorIds: ["actor:east"], upsert: [] },
      };
      const store = new SqliteTableConnectionStore(state.storage);
      const before = snapshot(sql);
      sql.exec(
        "CREATE TRIGGER fail_reconnect_revision BEFORE UPDATE ON lobby_state BEGIN SELECT RAISE(ABORT, 'injected reconnect revision failure'); END",
      );
      expect(() => {
        store.commitConnection(change);
      }).toThrow("injected reconnect revision failure");
      expect(snapshot(sql)).toEqual(before);
      sql.exec("DROP TRIGGER fail_reconnect_revision");
      store.commitConnection(change);
      expect(
        sql
          .exec(
            "SELECT autopilot, connection_generation FROM player_automation",
          )
          .one(),
      ).toEqual({ autopilot: 0, connection_generation: 2 });
      expect(sql.exec("SELECT * FROM bot_work").toArray()).toEqual([]);
      expect(store.grant("new-connection")).toEqual(change.grant);
      expect(sql.exec("SELECT state_version FROM lobby_state").one()).toEqual({
        state_version: 1,
      });
    });
  });
});
