import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import {
  preparePresenceReconciliation,
  prepareValidConnection,
} from "../../src/worker/durable-objects/table-room/table-presence-application.js";
import {
  readPresenceState,
  writePresenceChangesInTransaction,
} from "../../src/worker/durable-objects/table-room/table-room-presence.js";

function tableRoom(): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(`presence-store-${crypto.randomUUID()}`);
}

describe("table presence SQLite atomic commits", () => {
  it("rolls back reconnect state and earlier scheduled work when a later deadline insert fails", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO table_record (singleton, table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id) VALUES (1, 'presence-table', 'actor:east', 100, 'instance', 1, ?, 'binding')",
        "P".repeat(43),
      );
      sql.exec(
        "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES ('actor:east', 'East', 'owner', 100)",
      );
      sql.exec(
        "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES ('east', 'actor:east', 'East', 0)",
      );
      sql.exec(
        "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES ('actor:east', 1, 1, 100)",
      );
      sql.exec("UPDATE room_lifecycle SET abandoned = 1 WHERE singleton = 1");
      const before = readPresenceState(sql);
      const connection = prepareValidConnection(before, "actor:east", 1_000);
      const lifecycle = connection.changes.lifecycle;
      const automation = connection.changes.automation[0];
      if (lifecycle === undefined || automation?.type !== "upsert")
        throw new Error("Expected reconnect changes.");
      const reconciliation = preparePresenceReconciliation(
        { ...before, lifecycle, automation: [automation.automation] },
        {
          now: 1_000,
          observations: [{ actorId: "actor:east", expiresAt: 2_000 }],
        },
      );
      sql.exec(
        "CREATE TRIGGER fail_abandonment BEFORE INSERT ON deadlines WHEN NEW.kind = 'abandonment' BEGIN SELECT RAISE(ABORT, 'injected scheduling failure'); END",
      );
      expect(() => {
        state.storage.transactionSync(() => {
          writePresenceChangesInTransaction(sql, connection.changes);
          writePresenceChangesInTransaction(sql, reconciliation);
        });
      }).toThrow("injected scheduling failure");
      expect(readPresenceState(sql)).toEqual(before);
      sql.exec("DROP TRIGGER fail_abandonment");
      state.storage.transactionSync(() => {
        writePresenceChangesInTransaction(sql, connection.changes);
        writePresenceChangesInTransaction(sql, reconciliation);
      });
      const after = readPresenceState(sql);
      expect(after.automation).toEqual([
        { actorId: "actor:east", autopilot: false, connectionGeneration: 2 },
      ]);
      expect(after.lifecycle).toEqual({
        abandoned: false,
        roomActivityGeneration: 1,
      });
      expect(
        after.deadlines.map(({ deadlineId, dueAt }) => ({ deadlineId, dueAt })),
      ).toEqual([
        { deadlineId: "abandonment-expiry:1", dueAt: 902_000 },
        { deadlineId: "disconnect-expiry:2", dueAt: 17_000 },
      ]);
      expect(connection.publicTransition).toBe(true);
    });
  });
});
