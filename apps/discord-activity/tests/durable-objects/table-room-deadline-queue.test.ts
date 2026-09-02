import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import {
  cancelDeadline,
  canonicalDeadlineRequest,
  completeDeadlineWithReceipt,
  deadlineRaceOrder,
  deadlineTargetsCurrent,
  earliestPendingDeadline,
  MAX_DUE_DEADLINE_BATCH,
  planAlarmRepair,
  readDueDeadlines,
  scheduleDeadline,
  type PendingDeadline,
  verifyDeadlinePersistence,
} from "../../src/worker/durable-objects/table-room/deadline-queue.js";
import { migrateTableRoomStorageToV4 } from "../../src/worker/durable-objects/table-room/table-room-game-store.js";

function tableRoom(name: string): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(name);
}

const reactionDeadline = (
  deadlineId: string,
  dueAt: number,
  generation = 12,
): PendingDeadline => ({
  deadlineId,
  dueAt,
  kind: "reaction",
  payload: {
    openingSequence: generation,
    type: "system/reaction-expired",
    windowId: "reaction-window-12",
  },
  status: "pending",
  targetGeneration: generation,
});

describe("TableRoom deadline queue", () => {
  it("orders bounded due work by (dueAt, deadlineId) at the half-open boundary", async () => {
    const stub = tableRoom(`deadline-order-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      scheduleDeadline(
        state.storage.sql,
        reactionDeadline("reaction:z", 1_000),
      );
      scheduleDeadline(state.storage.sql, reactionDeadline("reaction:b", 900));
      scheduleDeadline(state.storage.sql, reactionDeadline("reaction:a", 900));
      expect(readDueDeadlines(state.storage.sql, 899)).toEqual([]);
      expect(
        readDueDeadlines(state.storage.sql, 900).map(
          ({ deadlineId }) => deadlineId,
        ),
      ).toEqual(["reaction:a", "reaction:b"]);
      expect(deadlineRaceOrder(899, 900)).toBe("user-first");
      expect(deadlineRaceOrder(900, 900)).toBe("deadline-first");
      expect(deadlineRaceOrder(901, 900)).toBe("deadline-first");
      expect(earliestPendingDeadline(state.storage.sql)).toBe(900);
    });
  });

  it("bounds alarm batches and rejects changed reuse of a stable deadline ID", async () => {
    const stub = tableRoom(`deadline-bound-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      for (let index = 0; index < MAX_DUE_DEADLINE_BATCH + 3; index += 1) {
        scheduleDeadline(
          state.storage.sql,
          reactionDeadline(`reaction:${String(index).padStart(2, "0")}`, 500),
        );
      }
      expect(readDueDeadlines(state.storage.sql, 500)).toHaveLength(
        MAX_DUE_DEADLINE_BATCH,
      );
      expect(() =>
        readDueDeadlines(state.storage.sql, 500, MAX_DUE_DEADLINE_BATCH + 1),
      ).toThrow("batch bounds");

      const original = reactionDeadline("reaction:stable", 600);
      scheduleDeadline(state.storage.sql, original);
      scheduleDeadline(state.storage.sql, original);
      expect(() => {
        scheduleDeadline(
          state.storage.sql,
          reactionDeadline("reaction:stable", 601),
        );
      }).toThrow("different input");
    });
  });

  it("makes stale generation checks explicit for every deadline kind", () => {
    const reaction = reactionDeadline("reaction:generation", 500, 12);
    expect(
      deadlineTargetsCurrent(reaction, {
        kind: "reaction",
        openingSequence: 12,
        targetGeneration: 12,
        windowId: "reaction-window-12",
      }),
    ).toBe(true);
    const turn: PendingDeadline = {
      deadlineId: "turn:east:20",
      dueAt: 800,
      kind: "turn",
      payload: {
        openingSequence: 20,
        phase: "awaiting-discard",
        seat: "east",
        type: "system/turn-expired",
      },
      status: "pending",
      targetGeneration: 20,
    };
    expect(
      deadlineTargetsCurrent(turn, {
        kind: "turn",
        openingSequence: 20,
        phase: "awaiting-discard",
        seat: "east",
        targetGeneration: 20,
      }),
    ).toBe(true);
    const disconnect: PendingDeadline = {
      deadlineId: "disconnect:actor-east:7",
      dueAt: 1_000,
      kind: "disconnect",
      payload: {
        actorId: "actor:east",
        connectionGeneration: 7,
        type: "system/disconnect-grace-expired",
      },
      status: "pending",
      targetGeneration: 7,
    };
    expect(
      deadlineTargetsCurrent(disconnect, {
        actorId: "actor:east",
        connectionGeneration: 7,
        kind: "disconnect",
        targetGeneration: 7,
      }),
    ).toBe(true);
    expect(
      deadlineTargetsCurrent(disconnect, {
        actorId: "actor:east",
        connectionGeneration: 8,
        kind: "disconnect",
        targetGeneration: 8,
      }),
    ).toBe(false);

    const abandonment: PendingDeadline = {
      deadlineId: "abandonment:9",
      dueAt: 2_000,
      kind: "abandonment",
      payload: {
        roomActivityGeneration: 9,
        type: "system/table-abandonment-expired",
      },
      status: "pending",
      targetGeneration: 9,
    };
    expect(
      deadlineTargetsCurrent(abandonment, {
        kind: "abandonment",
        roomActivityGeneration: 9,
        targetGeneration: 9,
      }),
    ).toBe(true);
    expect(
      deadlineTargetsCurrent(abandonment, {
        kind: "abandonment",
        roomActivityGeneration: 10,
        targetGeneration: 10,
      }),
    ).toBe(false);
  });

  it("enforces payload-generation coherence on writes and recovery", async () => {
    const stub = tableRoom(`deadline-generation-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      const coherent: readonly PendingDeadline[] = [
        reactionDeadline("reaction:coherent", 500, 12),
        {
          deadlineId: "turn:coherent",
          dueAt: 600,
          kind: "turn",
          payload: {
            openingSequence: 13,
            phase: "awaiting-draw",
            seat: "south",
            type: "system/turn-expired",
          },
          status: "pending",
          targetGeneration: 13,
        },
        {
          deadlineId: "disconnect:coherent",
          dueAt: 700,
          kind: "disconnect",
          payload: {
            actorId: "actor:east",
            connectionGeneration: 14,
            type: "system/disconnect-grace-expired",
          },
          status: "pending",
          targetGeneration: 14,
        },
        {
          deadlineId: "abandonment:coherent",
          dueAt: 800,
          kind: "abandonment",
          payload: {
            roomActivityGeneration: 15,
            type: "system/table-abandonment-expired",
          },
          status: "pending",
          targetGeneration: 15,
        },
      ];
      for (const deadline of coherent) {
        scheduleDeadline(state.storage.sql, deadline);
        expect(() => {
          scheduleDeadline(state.storage.sql, {
            ...deadline,
            deadlineId: `${deadline.deadlineId}:bad`,
            targetGeneration: deadline.targetGeneration + 1,
          });
        }).toThrow("outside the persisted contract");
      }
      state.storage.sql.exec(
        "UPDATE deadlines SET target_generation = 99 WHERE deadline_id = 'reaction:coherent'",
      );
      expect(() => {
        verifyDeadlinePersistence(state.storage.sql);
      }).toThrow("incoherent");
    });
  });

  it("persists one idempotent system receipt and does not rerun duplicate delivery", async () => {
    const stub = tableRoom(`deadline-receipt-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      const deadline = reactionDeadline("reaction:receipt", 1_000);
      scheduleDeadline(state.storage.sql, deadline);
      expect(() =>
        completeDeadlineWithReceipt(
          state.storage,
          deadline.deadlineId,
          999,
          () => ({ outcome: "processed", publicTransition: false }),
        ),
      ).toThrow("before its deadline");
      const first = completeDeadlineWithReceipt(
        state.storage,
        deadline.deadlineId,
        1_000,
        (sql) => {
          sql.exec(
            "UPDATE room_lifecycle SET room_activity_generation = room_activity_generation + 1, updated_at = 1000 WHERE singleton = 1",
          );
          return { outcome: "processed", publicTransition: true };
        },
      );
      expect(first.replayed).toBe(false);
      expect(first.receipt.result).toEqual({
        outcome: "processed",
        publicTransition: true,
      });
      const replay = completeDeadlineWithReceipt(
        state.storage,
        deadline.deadlineId,
        1_001,
        () => {
          throw new Error("a duplicate must not execute");
        },
      );
      expect(replay).toEqual({ ...first, replayed: true });
      expect(
        state.storage.sql
          .exec<{ room_activity_generation: number }>(
            "SELECT room_activity_generation FROM room_lifecycle WHERE singleton = 1",
          )
          .one().room_activity_generation,
      ).toBe(1);
      expect(readDueDeadlines(state.storage.sql, 2_000)).toEqual([]);
      expect(() => {
        verifyDeadlinePersistence(state.storage.sql);
      }).not.toThrow();
    });
  });

  it("rolls back authority writes when deadline completion fails", async () => {
    const stub = tableRoom(`deadline-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      const deadline = reactionDeadline("reaction:rollback", 1_000);
      scheduleDeadline(state.storage.sql, deadline);
      expect(() =>
        completeDeadlineWithReceipt(
          state.storage,
          deadline.deadlineId,
          1_000,
          (sql) => {
            sql.exec(
              "UPDATE room_lifecycle SET abandoned = 1, updated_at = 1000 WHERE singleton = 1",
            );
            throw new Error("injected authority failure");
          },
        ),
      ).toThrow("injected authority failure");
      expect(
        state.storage.sql
          .exec<{ abandoned: number }>(
            "SELECT abandoned FROM room_lifecycle WHERE singleton = 1",
          )
          .one().abandoned,
      ).toBe(0);
      expect(readDueDeadlines(state.storage.sql, 1_000)).toHaveLength(1);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM system_command_receipts",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("records and replays a durable no-op for late delivery after cancellation", async () => {
    const stub = tableRoom(`deadline-cancelled-late-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      const deadline = reactionDeadline("reaction:cancelled-late", 1_000);
      scheduleDeadline(state.storage.sql, deadline);
      expect(cancelDeadline(state.storage.sql, deadline.deadlineId)).toBe(true);
      const before = state.storage.sql
        .exec<{ room_activity_generation: number }>(
          "SELECT room_activity_generation FROM room_lifecycle WHERE singleton = 1",
        )
        .one().room_activity_generation;
      const first = completeDeadlineWithReceipt(
        state.storage,
        deadline.deadlineId,
        1_001,
        () => {
          throw new Error("cancelled work must not mutate authority");
        },
      );
      expect(first).toMatchObject({
        replayed: false,
        receipt: {
          processedAt: 1_001,
          result: { outcome: "no-op", reason: "cancelled" },
        },
      });
      const replay = completeDeadlineWithReceipt(
        state.storage,
        deadline.deadlineId,
        2_000,
        () => {
          throw new Error("cancelled replay must not execute");
        },
      );
      expect(replay).toEqual({ ...first, replayed: true });
      expect(
        state.storage.sql
          .exec<{ room_activity_generation: number }>(
            "SELECT room_activity_generation FROM room_lifecycle WHERE singleton = 1",
          )
          .one().room_activity_generation,
      ).toBe(before);
      expect(() => {
        verifyDeadlinePersistence(state.storage.sql);
      }).not.toThrow();
    });
  });

  it("enforces relational authority links", async () => {
    const stub = tableRoom(`deadline-foreign-key-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      expect(() =>
        state.storage.sql.exec(
          "INSERT INTO system_command_receipts (command_id, request_json, result_json, processed_at) VALUES ('missing-deadline', '{}', '{}', 1)",
        ),
      ).toThrow(/foreign key/iu);
      expect(() =>
        state.storage.sql.exec(
          "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES ('missing-member', 1, 0, 1)",
        ),
      ).toThrow(/foreign key/iu);
      state.storage.sql.exec(
        "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES ('automation-member', 'Automation Member', 'member', 1)",
      );
      state.storage.sql.exec(
        "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES ('automation-member', 1, 1, 1)",
      );
      state.storage.sql.exec(
        "DELETE FROM members WHERE actor_id = 'automation-member'",
      );
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM player_automation",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("fails closed on malformed payloads and invalid persisted receipts", async () => {
    const stub = tableRoom(`deadline-corruption-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      const deadline = reactionDeadline("reaction:corrupt", 1_000);
      scheduleDeadline(state.storage.sql, deadline);
      const payloadJson = state.storage.sql
        .exec<{ payload_json: string }>(
          "SELECT payload_json FROM deadlines WHERE deadline_id = ?",
          deadline.deadlineId,
        )
        .one().payload_json;
      state.storage.sql.exec(
        "UPDATE deadlines SET payload_json = ? WHERE deadline_id = ?",
        '{"extra":true,"openingSequence":12,"type":"system/reaction-expired","windowId":"reaction-window-12"}',
        deadline.deadlineId,
      );
      expect(() => {
        verifyDeadlinePersistence(state.storage.sql);
      }).toThrow("malformed");
      state.storage.sql.exec(
        "UPDATE deadlines SET payload_json = ?, status = 'processed', processed_at = 1000 WHERE deadline_id = ?",
        payloadJson,
        deadline.deadlineId,
      );
      const requestJson = canonicalDeadlineRequest(deadline);
      const invalidResults = [
        '{"extra":true,"outcome":"processed","publicTransition":false}',
        `{"outcome":"no-op","reason":"${"😀".repeat(400)}"}`,
        '{"outcome":"processed","publicTransition":1e400}',
      ] as const;
      for (const resultJson of invalidResults) {
        state.storage.sql.exec(
          "INSERT INTO system_command_receipts (command_id, request_json, result_json, processed_at) VALUES (?, ?, ?, 1000)",
          deadline.deadlineId,
          requestJson,
          resultJson,
        );
        expect(() => {
          verifyDeadlinePersistence(state.storage.sql);
        }).toThrow(/malformed|size bound|finite/iu);
        state.storage.sql.exec(
          "DELETE FROM system_command_receipts WHERE command_id = ?",
          deadline.deadlineId,
        );
      }
    });
  });

  it("plans one-alarm repair without overwriting an already earlier alarm", async () => {
    expect(planAlarmRepair(null, undefined)).toEqual({ action: "keep" });
    expect(planAlarmRepair(900, undefined)).toEqual({ action: "delete" });
    expect(planAlarmRepair(null, 1_000)).toEqual({
      action: "set",
      scheduledTime: 1_000,
    });
    expect(planAlarmRepair(900, 1_000)).toEqual({ action: "keep" });
    expect(planAlarmRepair(1_100, 1_000)).toEqual({
      action: "set",
      scheduledTime: 1_000,
    });

    const stub = tableRoom(`deadline-cancel-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      migrateTableRoomStorageToV4(state.storage);
      scheduleDeadline(
        state.storage.sql,
        reactionDeadline("reaction:cancel", 1_000),
      );
      expect(cancelDeadline(state.storage.sql, "reaction:cancel")).toBe(true);
      expect(cancelDeadline(state.storage.sql, "reaction:cancel")).toBe(false);
      expect(readDueDeadlines(state.storage.sql, 1_000)).toEqual([]);
      expect(earliestPendingDeadline(state.storage.sql)).toBeUndefined();
    });
  });
});
