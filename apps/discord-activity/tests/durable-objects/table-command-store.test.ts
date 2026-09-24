import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applyGameCommandV2,
  startHongKongV2Game,
} from "@mahjong/rules-hong-kong";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import {
  scheduleDeadline,
  verifyDeadlinePersistence,
} from "../../src/worker/durable-objects/table-room/deadline-queue.js";
import type { PreparedTableCommand } from "../../src/worker/durable-objects/table-room/table-command-application.js";
import { SqliteTableCommandStore } from "../../src/worker/durable-objects/table-room/table-command-store.js";
import {
  prepareDeadlineCompletion,
  type PendingDeadline,
} from "../../src/worker/durable-objects/table-room/table-deadline-application.js";
import { prepareGameEventBatch } from "../../src/worker/durable-objects/table-room/table-game-events.js";
import { preparePresenceReconciliation } from "../../src/worker/durable-objects/table-room/table-presence-application.js";
import {
  persistPreparedGameBatch,
  verifyStoredGame,
} from "../../src/worker/durable-objects/table-room/table-room-game-store.js";
import type { PreparedSystemOperation } from "../../src/worker/durable-objects/table-room/table-system-application.js";

function tableRoom(): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(`command-store-${crypto.randomUUID()}`);
}

function snapshot(sql: SqlStorage) {
  return {
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
    version: sql.exec("SELECT * FROM lobby_state").toArray(),
    seats: sql.exec("SELECT * FROM lobby_seats ORDER BY seat").toArray(),
    automation: sql
      .exec("SELECT * FROM player_automation ORDER BY actor_id")
      .toArray(),
    lifecycle: sql.exec("SELECT * FROM room_lifecycle").toArray(),
  };
}

function initializeMembers(sql: SqlStorage): void {
  sql.exec(
    "INSERT INTO table_record (singleton, table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id) VALUES (1, 'command-table', 'actor:east', 100, 'instance', 1, ?, 'binding')",
    "P".repeat(43),
  );
  for (const seat of ["east", "south", "west", "north"]) {
    sql.exec(
      "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, ?, 100)",
      `actor:${seat}`,
      seat,
      seat === "east" ? "owner" : "member",
    );
  }
}

function reactionDeadline(
  deadlineId: string,
  dueAt: number,
  generation: number,
): PendingDeadline {
  return {
    deadlineId,
    dueAt,
    kind: "reaction",
    payload: {
      type: "system/reaction-expired",
      openingSequence: generation,
      windowId: `window:${String(generation)}`,
    },
    status: "pending",
    targetGeneration: generation,
  };
}

async function prepareMove(storage: DurableObjectStorage) {
  const started = startHongKongV2Game(
    {
      east: "actor:east",
      south: "actor:south",
      west: "actor:west",
      north: "actor:north",
    },
    Uint8Array.from({ length: 1_028 }, (_, index) => (index * 41 + 17) & 0xff),
  );
  persistPreparedGameBatch(
    storage,
    await prepareGameEventBatch(undefined, [started.event]),
  );
  const stored = await verifyStoredGame(storage.sql);
  if (stored?.state.schemaVersion !== 2)
    throw new Error("Expected schema-v2 fixture.");
  const dealer = [
    stored.state.players.east,
    stored.state.players.south,
    stored.state.players.west,
    stored.state.players.north,
  ].find(({ seat }) => seat === stored.state.turn);
  const tileId = dealer?.hand[0];
  if (dealer === undefined || tileId === undefined)
    throw new Error("Expected dealer tile.");
  const discarded = applyGameCommandV2(stored.state, dealer.actorId, {
    type: "game/discard",
    tileId,
  });
  if (!discarded.accepted) throw new Error(discarded.error.message);
  return {
    actorId: dealer.actorId,
    game: await prepareGameEventBatch(stored, discarded.events),
  };
}

function commandChange(commandId: string): PreparedTableCommand {
  return {
    commandId,
    now: 1_000,
    receipt: {
      actorId: "actor:east",
      requestJson: JSON.stringify({
        command: { type: "lobby/set-ready", ready: true },
        commandId,
        expectedStateVersion: 0,
        protocolVersion: 2,
        type: "table/command",
      }),
      response: JSON.stringify({
        type: "table/receipt",
        protocolVersion: 2,
        commandId,
        outcome: "applied",
        stateVersion: 1,
      }),
    },
    stateVersion: 1,
    seatChange: { kind: "none" },
    game: undefined,
    gameDeadlines: undefined,
    presence: undefined,
  };
}

describe("table operation SQLite atomic commits", () => {
  it("rolls back events, checkpoint, replacement deadlines, and revision on command receipt failure", async () => {
    await runInDurableObject(tableRoom(), async (_instance, state) => {
      const sql = state.storage.sql;
      initializeMembers(sql);
      const store = new SqliteTableCommandStore(state.storage);
      const move = await prepareMove(state.storage);
      const old = reactionDeadline("reaction:old", 100, 1);
      scheduleDeadline(sql, old);
      const change: PreparedTableCommand = {
        ...commandChange("discard"),
        game: move.game,
        gameDeadlines: {
          cancel: [old.deadlineId],
          schedule: [reactionDeadline("reaction:new", 9_000, 2)],
        },
      };
      const before = snapshot(sql);
      sql.exec(
        "CREATE TRIGGER fail_command_receipt BEFORE INSERT ON lobby_command_receipts BEGIN SELECT RAISE(ABORT, 'injected command receipt failure'); END",
      );
      expect(() => store.commitCommand(change)).toThrow(
        "injected command receipt failure",
      );
      expect(snapshot(sql)).toEqual(before);
      sql.exec("DROP TRIGGER fail_command_receipt");
      expect(store.commitCommand(change)).toEqual({ kind: "committed" });
      await expect(verifyStoredGame(sql)).resolves.toMatchObject({
        state: move.game.finalState,
      });
      const committed = snapshot(sql);
      expect(store.commitCommand(change)).toEqual({
        kind: "duplicate",
        receipt: change.receipt,
      });
      expect(snapshot(sql)).toEqual(committed);
      // Deliberate prepared-batch reuse: production owns serialization, while
      // SQLite sequence uniqueness still rejects invalid operation reuse.
      expect(() =>
        store.commitCommand({ ...change, commandId: "different-command" }),
      ).toThrow("UNIQUE constraint failed: game_events.sequence");
      expect(snapshot(sql)).toEqual(committed);
    });
  });

  it("rolls back seat and presence reconstruction when the final command receipt fails", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const sql = state.storage.sql;
      initializeMembers(sql);
      const store = new SqliteTableCommandStore(state.storage);
      const presence = preparePresenceReconciliation(
        { ...store.presenceState(), seatedActorIds: ["actor:east"] },
        { now: 1_000, observations: [] },
      );
      const change: PreparedTableCommand = {
        ...commandChange("claim-seat"),
        seatChange: {
          kind: "put",
          seat: {
            actorId: "actor:east",
            displayName: "East",
            seat: "east",
            ready: false,
          },
        },
        presence,
      };
      const before = snapshot(sql);
      sql.exec(
        "CREATE TRIGGER fail_command_receipt BEFORE INSERT ON lobby_command_receipts BEGIN SELECT RAISE(ABORT, 'injected command receipt failure'); END",
      );
      expect(() => store.commitCommand(change)).toThrow(
        "injected command receipt failure",
      );
      expect(snapshot(sql)).toEqual(before);
      sql.exec("DROP TRIGGER fail_command_receipt");
      expect(store.commitCommand(change).kind).toBe("committed");
      expect(store.presenceState().automation).toEqual([
        { actorId: "actor:east", autopilot: false, connectionGeneration: 1 },
      ]);
      expect(store.presenceState().deadlines).toHaveLength(2);
    });
  });

  it("rolls back canonical progress, autopilot, work, and revision when a system receipt fails", async () => {
    await runInDurableObject(tableRoom(), async (_instance, state) => {
      const sql = state.storage.sql;
      initializeMembers(sql);
      const store = new SqliteTableCommandStore(state.storage);
      const move = await prepareMove(state.storage);
      sql.exec(
        "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES (?, 1, 0, 100)",
        move.actorId,
      );
      const deadline: PendingDeadline = {
        deadlineId: "disconnect:1",
        dueAt: 1_000,
        kind: "disconnect",
        payload: {
          type: "system/disconnect-grace-expired",
          actorId: move.actorId,
          connectionGeneration: 1,
        },
        status: "pending",
        targetGeneration: 1,
      };
      scheduleDeadline(sql, deadline);
      scheduleDeadline(sql, reactionDeadline("reaction:old", 1_000, 1));
      const change: PreparedSystemOperation = {
        completion: prepareDeadlineCompletion(deadline, 1_000, {
          outcome: "processed",
          publicTransition: true,
        }),
        game: move.game,
        gameDeadlines: {
          cancel: ["reaction:old"],
          schedule: [reactionDeadline("reaction:new", 9_000, 2)],
        },
        presence: {
          automation: [
            {
              type: "upsert",
              automation: {
                actorId: move.actorId,
                autopilot: true,
                connectionGeneration: 2,
              },
            },
          ],
          deadlineCancellations: [],
          deadlineReschedules: [],
          deadlineSchedules: [],
          updatedAt: 1_000,
        },
        abandonRoom: false,
        publicTransition: true,
        now: 1_000,
      };
      const before = snapshot(sql);
      sql.exec(
        "CREATE TRIGGER fail_system_receipt BEFORE INSERT ON system_command_receipts BEGIN SELECT RAISE(ABORT, 'injected system receipt failure'); END",
      );
      expect(() => {
        store.commitSystem(change);
      }).toThrow("injected system receipt failure");
      expect(snapshot(sql)).toEqual(before);
      sql.exec("DROP TRIGGER fail_system_receipt");
      store.commitSystem(change);
      expect(store.presenceState().automation).toEqual([
        { actorId: move.actorId, autopilot: true, connectionGeneration: 2 },
      ]);
      expect(store.deadlineCompletion(deadline.deadlineId).receipt).toEqual(
        change.completion.receipt,
      );
      await expect(verifyStoredGame(sql)).resolves.toMatchObject({
        state: move.game.finalState,
      });
      verifyDeadlinePersistence(sql);
      const committed = snapshot(sql);
      expect(() => {
        store.commitSystem(change);
      }).toThrow("UNIQUE constraint failed: game_events.sequence");
      expect(snapshot(sql)).toEqual(committed);
    });
  });
  it("rolls back abandonment when its final system receipt fails", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const sql = state.storage.sql;
      initializeMembers(sql);
      const store = new SqliteTableCommandStore(state.storage);
      const deadline: PendingDeadline = {
        deadlineId: "abandonment:0",
        dueAt: 1_000,
        kind: "abandonment",
        payload: {
          type: "system/table-abandonment-expired",
          roomActivityGeneration: 0,
        },
        status: "pending",
        targetGeneration: 0,
      };
      scheduleDeadline(sql, deadline);
      const change: PreparedSystemOperation = {
        completion: prepareDeadlineCompletion(deadline, 1_000, {
          outcome: "processed",
          publicTransition: true,
        }),
        game: undefined,
        gameDeadlines: undefined,
        abandonRoom: true,
        publicTransition: true,
        now: 1_000,
      };
      const before = snapshot(sql);
      sql.exec(
        "CREATE TRIGGER fail_system_receipt BEFORE INSERT ON system_command_receipts BEGIN SELECT RAISE(ABORT, 'injected system receipt failure'); END",
      );
      expect(() => {
        store.commitSystem(change);
      }).toThrow("injected system receipt failure");
      expect(snapshot(sql)).toEqual(before);
      sql.exec("DROP TRIGGER fail_system_receipt");
      store.commitSystem(change);
      expect(store.presenceState().lifecycle.abandoned).toBe(true);
      expect(store.deadlineCompletion(deadline.deadlineId).receipt).toEqual(
        change.completion.receipt,
      );
      verifyDeadlinePersistence(sql);
    });
  });
});
