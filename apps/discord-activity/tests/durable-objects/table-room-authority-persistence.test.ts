import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { startHongKongV1Game } from "@mahjong/rules-hong-kong";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import {
  persistPreparedGameBatch,
  prepareGameEventBatch,
  validateTableRoomStorageV1,
  verifyStoredGame,
} from "../../src/worker/durable-objects/table-room/table-room-game-store.js";
import { tableRoomV1CurrentSchema } from "../fixtures/table-room-v1-current-schema.js";

const ALL_TABLES = [
  "bot_work",
  "bot_players",
  "player_automation",
  "room_lifecycle",
  "system_command_receipts",
  "deadlines",
  "game_events",
  "canonical_game_state",
  "lobby_command_receipts",
  "lobby_seats",
  "lobby_state",
  "connection_grants",
  "actor_sessions",
  "capabilities",
  "binding_receipts",
  "members",
  "table_record",
  "storage_metadata",
] as const;

function tableRoom(name: string): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(name);
}

function replaceWithPermanentV1Schema(sql: SqlStorage): void {
  for (const table of ALL_TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const statement of tableRoomV1CurrentSchema) sql.exec(statement);
  sql.exec(
    "INSERT INTO storage_metadata (singleton, schema_version) VALUES (1, 1)",
  );
  sql.exec("INSERT INTO lobby_state (singleton, state_version) VALUES (1, 0)");
  sql.exec(
    "INSERT INTO room_lifecycle (singleton, room_activity_generation, abandoned, updated_at) VALUES (1, 0, 0, 0)",
  );
}

function startedGame() {
  return startHongKongV1Game(
    {
      east: "stable:east",
      south: "stable:south",
      west: "stable:west",
      north: "stable:north",
    },
    Uint8Array.from({ length: 1_028 }, (_, index) => (index * 41 + 17) & 0xff),
  );
}

describe("TableRoom v1 authority persistence", () => {
  it("matches the permanent schema fixture and recovers its game after eviction", async () => {
    const stub = tableRoom(`authority-v1-fixture-${crypto.randomUUID()}`);
    const started = startedGame();
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const created = sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .toArray()
        .map(({ sql: statement }) => statement);
      expect(created.sort()).toEqual([...tableRoomV1CurrentSchema].sort());
      replaceWithPermanentV1Schema(sql);
      expect(() => {
        validateTableRoomStorageV1(state.storage);
      }).not.toThrow();
      const genesis = await prepareGameEventBatch(undefined, [started.event]);
      persistPreparedGameBatch(state.storage, genesis);
      expect((await verifyStoredGame(sql))?.state).toEqual(started.state);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect((await verifyStoredGame(state.storage.sql))?.state).toEqual(
        started.state,
      );
    });
  });

  it.each(["bot_players", "bot_work"] as const)(
    "rejects v1 when %s loses its cascading foreign key",
    async (table) => {
      const stub = tableRoom(`authority-v1-constraints-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql;
        const original = sql
          .exec<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            table,
          )
          .one().sql;
        sql.exec(`DROP TABLE ${table}`);
        sql.exec(original.replace(/, FOREIGN KEY.*\)$/u, ")"));
        expect(() => {
          validateTableRoomStorageV1(state.storage);
        }).toThrow("bot foreign keys are missing");
        sql.exec(`DROP TABLE ${table}`);
        sql.exec(original);
      });
    },
  );

  it("rejects an unsupported schema version on recovery", async () => {
    const stub = tableRoom(`authority-unknown-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE storage_metadata SET schema_version = 2 WHERE singleton = 1",
      );
    });
    await evictDurableObject(stub);
    await expect(runInDurableObject(stub, () => undefined)).rejects.toThrow(
      "Unsupported TableRoom storage schema version",
    );
  });

  it("keeps a prepared game batch atomic when a related write fails", async () => {
    const stub = tableRoom(`authority-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const batch = await prepareGameEventBatch(undefined, [
        startedGame().event,
      ]);
      expect(() => {
        persistPreparedGameBatch(state.storage, batch, (sql) => {
          sql.exec(
            "UPDATE lobby_state SET state_version = 10 WHERE singleton = 1",
          );
          throw new Error("injected related-write failure");
        });
      }).toThrow("injected related-write failure");
      expect(await verifyStoredGame(state.storage.sql)).toBeUndefined();
      expect(
        state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      ).toBe(0);
    });
  });

  it("rejects a corrupted event hash before trusting its checkpoint", async () => {
    const stub = tableRoom(`authority-corrupt-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const batch = await prepareGameEventBatch(undefined, [
        startedGame().event,
      ]);
      persistPreparedGameBatch(state.storage, batch);
      state.storage.sql.exec(
        "UPDATE game_events SET event_hash = ? WHERE sequence = 1",
        "0".repeat(64),
      );
      await expect(verifyStoredGame(state.storage.sql)).rejects.toThrow(
        "hash verification failed",
      );
    });
  });
});
