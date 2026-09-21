import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applyGameCommandV2,
  projectGame,
  projectGameV2,
  projectLegacyCompatibleGameV2,
  startHongKongV2Game,
  type CanonicalGameStateV2,
} from "@mahjong/rules-hong-kong";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import {
  migrateTableRoomStorageToV6,
  persistPreparedGameBatch,
  prepareGameEventBatch,
  prepareV1GameUpgrade,
  verifyStoredGame,
} from "../../src/worker/durable-objects/table-room/table-room-game-store.js";
import { tableRoomV1Schema } from "../fixtures/table-room-v1-schema.js";
import { tableRoomV3ActiveV1GameFixture } from "../fixtures/table-room-v3-active-v1-game.js";

import { tableRoomV4Schema } from "../fixtures/table-room-v4-schema.js";
import { tableRoomV5Schema } from "../fixtures/table-room-v5-schema.js";
import {
  readBotWork,
  readPlayerControls,
  verifyBotPersistence,
} from "../../src/worker/durable-objects/table-room/table-room-bots.js";

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

function playerForSeat(
  state: CanonicalGameStateV2,
  selectedSeat: CanonicalGameStateV2["turn"],
): CanonicalGameStateV2["players"]["east"] {
  const player = [
    state.players.east,
    state.players.south,
    state.players.west,
    state.players.north,
  ].find(({ seat }) => seat === selectedSeat);
  if (player === undefined) throw new Error("Canonical seat has no player.");
  return player;
}

function replaceSchema(sql: SqlStorage, statements: readonly string[]): void {
  for (const table of ALL_TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const statement of statements) sql.exec(statement);
}

function installActiveV3Fixture(sql: SqlStorage): void {
  const fixture = tableRoomV3ActiveV1GameFixture;
  replaceSchema(sql, fixture.schema);
  sql.exec(
    "INSERT INTO storage_metadata (singleton, schema_version) VALUES (1, ?)",
    fixture.schemaVersion,
  );
  sql.exec(
    "INSERT INTO table_record (singleton, table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id) VALUES (1, ?, 'actor:east', 100, 'fixture-instance', 3, ?, 'fixture-binding')",
    fixture.tableId,
    "B".repeat(43),
  );
  sql.exec(
    "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES ('actor:east', 'East', 'owner', 100), ('actor:south', 'South', 'member', 101), ('actor:west', 'West', 'member', 102), ('actor:north', 'North', 'member', 103)",
  );
  sql.exec(
    "INSERT INTO lobby_state (singleton, state_version) VALUES (1, ?)",
    fixture.lobbyStateVersion,
  );
  sql.exec(
    "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES ('east', 'actor:south', 'South', 1), ('south', 'actor:west', 'West', 1), ('west', 'actor:north', 'North', 1), ('north', 'actor:east', 'East', 1)",
  );
  sql.exec(
    "INSERT INTO canonical_game_state (singleton, state_json, last_event_hash) VALUES (1, ?, ?)",
    fixture.checkpointStateJson,
    fixture.lastEventHash,
  );
  for (const event of fixture.events) {
    sql.exec(
      "INSERT INTO game_events (sequence, event_json, previous_hash, event_hash) VALUES (?, ?, ?, ?)",
      event.sequence,
      event.eventJson,
      event.previousHash,
      event.eventHash,
    );
  }
}

const V5_BOT_ID = "bot:00000000-0000-4000-8000-000000000001";

function installV5BotFixture(sql: SqlStorage): void {
  replaceSchema(sql, tableRoomV5Schema);
  sql.exec("INSERT INTO storage_metadata VALUES (1, 5)");
  sql.exec("INSERT INTO lobby_state VALUES (1, 7)");
  sql.exec("INSERT INTO room_lifecycle VALUES (1, 3, 0, 100)");
  sql.exec(
    "INSERT INTO members VALUES ('old-owner', 'Old Owner', 'owner', 100), (?, 'Bot South', 'member', 100)",
    V5_BOT_ID,
  );
  sql.exec(
    "INSERT INTO lobby_seats VALUES ('east', 'old-owner', 'Old Owner', 1), ('south', ?, 'Bot South', 1)",
    V5_BOT_ID,
  );
  sql.exec("INSERT INTO bot_players VALUES (?, 'random/v1')", V5_BOT_ID);
  sql.exec(
    "INSERT INTO bot_work VALUES (?, 'turn:12', 'persisted-v5-command', 1000)",
    V5_BOT_ID,
  );
}

describe("TableRoom authority persistence primitives", () => {
  it("migrates retained v5 bot work without changing command identity, target, deadline, or seats", async () => {
    const stub = tableRoom(`authority-v5-work-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      installV5BotFixture(sql);
      const before = {
        seats: sql.exec("SELECT * FROM lobby_seats ORDER BY seat").toArray(),
        lifecycle: sql.exec("SELECT * FROM room_lifecycle").toArray(),
        version: sql.exec("SELECT * FROM lobby_state").toArray(),
      };
      migrateTableRoomStorageToV6(state.storage);
      migrateTableRoomStorageToV6(state.storage);
      expect(readBotWork(sql)).toEqual([
        {
          actor_id: V5_BOT_ID,
          target: "turn:12",
          command_id: "persisted-v5-command",
          due_at: 1000,
          controller_generation: 0,
        },
      ]);
      expect({
        seats: sql.exec("SELECT * FROM lobby_seats ORDER BY seat").toArray(),
        lifecycle: sql.exec("SELECT * FROM room_lifecycle").toArray(),
        version: sql.exec("SELECT * FROM lobby_state").toArray(),
      }).toEqual(before);
      expect(
        sql.exec("SELECT schema_version FROM storage_metadata").one(),
      ).toEqual({ schema_version: 6 });
      expect(() => {
        sql.exec("UPDATE bot_work SET controller_generation = -1");
      }).toThrow();
      expect(() => {
        sql.exec(
          "UPDATE bot_work SET controller_generation = 9007199254740992",
        );
      }).toThrow();
      expect(() => {
        sql.exec("UPDATE bot_work SET controller_generation = NULL");
      }).toThrow();
      expect(() => {
        verifyBotPersistence(sql);
      }).not.toThrow();
      sql.exec("DELETE FROM lobby_seats WHERE actor_id = ?", V5_BOT_ID);
      sql.exec("DELETE FROM members WHERE actor_id = ?", V5_BOT_ID);
      expect(sql.exec("SELECT * FROM bot_players").toArray()).toEqual([]);
      expect(readBotWork(sql)).toEqual([]);
    });
  });

  it("retains human identity while persisting substitute generations and tolerates work awaiting cancellation", async () => {
    const stub = tableRoom(`authority-v6-controls-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      installV5BotFixture(sql);
      migrateTableRoomStorageToV6(state.storage);
      sql.exec("INSERT INTO player_automation VALUES ('old-owner', 7, 1, 100)");
      sql.exec(
        "INSERT INTO members VALUES ('bot:legacy-human', 'Legacy Human', 'member', 100)",
      );
      sql.exec(
        "INSERT INTO lobby_seats VALUES ('west', 'bot:legacy-human', 'Legacy Human', 1)",
      );
      sql.exec(
        "INSERT INTO bot_work VALUES ('old-owner', 'reaction:window-1', 'human-substitute-command', 1001, 7)",
      );
      expect(readPlayerControls(sql)).toEqual([
        { actorId: V5_BOT_ID, kind: "BOT", controller: "BOT", generation: 0 },
        {
          actorId: "bot:legacy-human",
          kind: "HUMAN",
          controller: "HUMAN",
          generation: 0,
        },
        {
          actorId: "old-owner",
          kind: "HUMAN",
          controller: "BOT",
          generation: 7,
        },
      ]);
      expect(readBotWork(sql)).toHaveLength(2);
      sql.exec(
        "UPDATE player_automation SET connection_generation = 8, autopilot = 0 WHERE actor_id = 'old-owner'",
      );
      expect(
        readPlayerControls(sql).find(({ actorId }) => actorId === "old-owner"),
      ).toEqual({
        actorId: "old-owner",
        kind: "HUMAN",
        controller: "HUMAN",
        generation: 8,
      });
      // Reconciliation cancels old work; storage decoding must not fail before it can run.
      expect(
        readBotWork(sql).find(({ actor_id }) => actor_id === "old-owner")
          ?.controller_generation,
      ).toBe(7);
      expect(() => {
        verifyBotPersistence(sql);
      }).not.toThrow();
      sql.exec("DELETE FROM lobby_seats WHERE actor_id = 'old-owner'");
      sql.exec("DELETE FROM members WHERE actor_id = 'old-owner'");
      expect(readBotWork(sql).map(({ actor_id }) => actor_id)).toEqual([
        V5_BOT_ID,
      ]);
    });
  });

  it("does not legitimize a human job corrupted into the dedicated-bot v5 schema", async () => {
    const stub = tableRoom(`authority-v5-invalid-owner-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      installV5BotFixture(sql);
      state.storage.transactionSync(() => {
        sql.exec("PRAGMA defer_foreign_keys = ON");
        sql.exec(
          "INSERT INTO bot_work VALUES ('old-owner', 'turn:12', 'corrupt-human-job', 1000)",
        );
        const before = sql
          .exec("SELECT * FROM bot_work ORDER BY actor_id")
          .toArray();
        expect(() => {
          migrateTableRoomStorageToV6(state.storage);
        }).toThrow("schema-v5 foreign keys are violated");
        expect(
          sql.exec("SELECT schema_version FROM storage_metadata").one(),
        ).toEqual({ schema_version: 5 });
        expect(
          sql.exec("SELECT * FROM bot_work ORDER BY actor_id").toArray(),
        ).toEqual(before);
        sql.exec("DELETE FROM bot_work WHERE actor_id = 'old-owner'");
      });
      migrateTableRoomStorageToV6(state.storage);
    });
  });

  it("rolls back the v5 migration when retained bot work is malformed", async () => {
    const stub = tableRoom(`authority-v5-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      installV5BotFixture(sql);
      sql.exec("UPDATE bot_work SET target = 'invalid'");
      const work = sql.exec("SELECT * FROM bot_work").toArray();
      expect(() => {
        migrateTableRoomStorageToV6(state.storage);
      }).toThrow("Persisted bot work is malformed");
      expect(
        sql.exec("SELECT schema_version FROM storage_metadata").one(),
      ).toEqual({ schema_version: 5 });
      expect(sql.exec("SELECT * FROM bot_work").toArray()).toEqual(work);
      expect(
        sql
          .exec("SELECT name FROM sqlite_master WHERE name = 'bot_work_v5'")
          .toArray(),
      ).toEqual([]);
      // Leave a valid schema for the object's remaining lifecycle hooks.
      sql.exec("UPDATE bot_work SET target = 'turn:12'");
      migrateTableRoomStorageToV6(state.storage);
    });
  });

  it.each(["bot_players", "bot_work"] as const)(
    "rejects schema v6 when %s loses its cascading foreign key",
    async (table) => {
      const stub = tableRoom(`authority-v5-constraints-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql;
        const original = sql
          .exec<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            table,
          )
          .one().sql;
        // Existing rows alone cannot prove that future deletes remain atomic.
        for (const replacement of [
          original.replace(/, FOREIGN KEY.*\)$/u, ")"),
          original.replace("ON DELETE CASCADE", "ON DELETE RESTRICT"),
        ]) {
          sql.exec(`DROP TABLE ${table}`);
          sql.exec(replacement);
          expect(() => {
            migrateTableRoomStorageToV6(state.storage);
          }).toThrow("schema-v6 bot foreign keys are missing");
        }
        sql.exec(`DROP TABLE ${table}`);
        sql.exec(original);
        expect(() => {
          migrateTableRoomStorageToV6(state.storage);
        }).not.toThrow();
      });
    },
  );

  it("migrates the permanent v4 schema, preserving human seats and lifecycle", async () => {
    const stub = tableRoom(`authority-v4-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      replaceSchema(sql, tableRoomV4Schema);
      sql.exec("INSERT INTO storage_metadata VALUES (1, 4)");
      sql.exec("INSERT INTO lobby_state VALUES (1, 7)");
      sql.exec("INSERT INTO room_lifecycle VALUES (1, 3, 1, 100)");
      sql.exec(
        "INSERT INTO members VALUES ('old-owner', 'Old Owner', 'owner', 100)",
      );
      sql.exec(
        "INSERT INTO lobby_seats VALUES ('east', 'old-owner', 'Old Owner', 1)",
      );
      const before = sql.exec("SELECT * FROM lobby_seats").toArray();
      migrateTableRoomStorageToV6(state.storage);
      migrateTableRoomStorageToV6(state.storage);
      expect(sql.exec("SELECT * FROM lobby_seats").toArray()).toEqual(before);
      expect(sql.exec("SELECT * FROM lobby_state").one()).toEqual({
        singleton: 1,
        state_version: 7,
      });
      expect(sql.exec("SELECT * FROM room_lifecycle").one()).toEqual({
        singleton: 1,
        room_activity_generation: 3,
        abandoned: 1,
        updated_at: 100,
      });
      expect(
        sql.exec("SELECT schema_version FROM storage_metadata").one(),
      ).toEqual({ schema_version: 6 });
      expect(sql.exec("SELECT * FROM bot_players").toArray()).toEqual([]);
      expect(sql.exec("SELECT * FROM bot_work").toArray()).toEqual([]);
    });
  });

  it("migrates the permanent v1 storage root through v6 without losing access data", async () => {
    const stub = tableRoom(`authority-v1-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      replaceSchema(state.storage.sql, tableRoomV1Schema);
      state.storage.sql.exec(
        "INSERT INTO storage_metadata (singleton, schema_version) VALUES (1, 1)",
      );
      state.storage.sql.exec(
        "INSERT INTO table_record (singleton, table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id) VALUES (1, 'old-table', 'old-owner', 100, 'old-instance', 7, ?, 'old-binding')",
        "B".repeat(43),
      );
      state.storage.sql.exec(
        "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES ('old-owner', 'Old Owner', 'owner', 100)",
      );

      migrateTableRoomStorageToV6(state.storage);

      expect(
        state.storage.sql
          .exec<{ schema_version: number }>(
            "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
          )
          .one().schema_version,
      ).toBe(6);
      expect(
        state.storage.sql
          .exec<{ owner_actor_id: string }>(
            "SELECT owner_actor_id FROM table_record WHERE singleton = 1",
          )
          .one().owner_actor_id,
      ).toBe("old-owner");
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM members")
          .one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ abandoned: number; room_activity_generation: number }>(
            "SELECT room_activity_generation, abandoned FROM room_lifecycle WHERE singleton = 1",
          )
          .one(),
      ).toEqual({ abandoned: 0, room_activity_generation: 0 });
    });
  });

  it("migrates schema v2 through v6 without losing lobby state or receipts", async () => {
    const stub = tableRoom(`authority-v2-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      replaceSchema(
        state.storage.sql,
        tableRoomV3ActiveV1GameFixture.schema.slice(0, -2),
      );
      state.storage.sql.exec(
        "INSERT INTO storage_metadata (singleton, schema_version) VALUES (1, 2)",
      );
      state.storage.sql.exec(
        "INSERT INTO table_record (singleton, table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id) VALUES (1, 'v2-table', 'v2-owner', 100, 'v2-instance', 2, ?, 'v2-binding')",
        "B".repeat(43),
      );
      state.storage.sql.exec(
        "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES ('v2-owner', 'V2 Owner', 'owner', 100)",
      );
      state.storage.sql.exec(
        "INSERT INTO lobby_state (singleton, state_version) VALUES (1, 6)",
      );
      state.storage.sql.exec(
        "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES ('east', 'v2-owner', 'V2 Owner', 1)",
      );
      state.storage.sql.exec(
        "INSERT INTO lobby_command_receipts (command_id, actor_id, request_json, response_json, created_at) VALUES ('v2-command', 'v2-owner', '{}', '{}', 101)",
      );

      migrateTableRoomStorageToV6(state.storage);

      expect(
        state.storage.sql
          .exec<{ schema_version: number }>(
            "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
          )
          .one().schema_version,
      ).toBe(6);
      expect(
        state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      ).toBe(6);
      expect(
        state.storage.sql
          .exec<{ actor_id: string; ready: number }>(
            "SELECT actor_id, ready FROM lobby_seats WHERE seat = 'east'",
          )
          .one(),
      ).toEqual({ actor_id: "v2-owner", ready: 1 });
      expect(
        state.storage.sql
          .exec<{ command_id: string }>(
            "SELECT command_id FROM lobby_command_receipts",
          )
          .one().command_id,
      ).toBe("v2-command");
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM game_events")
          .one().count,
      ).toBe(0);
    });
  });

  it("verifies and hash-preservingly upgrades the permanent active v3/v1 game", async () => {
    const stub = tableRoom(`authority-v3-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      installActiveV3Fixture(state.storage.sql);
      migrateTableRoomStorageToV6(state.storage);
      const legacy = await verifyStoredGame(state.storage.sql);
      expect(legacy?.lastEventHash).toBe(
        tableRoomV3ActiveV1GameFixture.lastEventHash,
      );
      if (legacy?.state.schemaVersion !== 1) {
        throw new Error("The fixture did not recover as canonical schema v1.");
      }
      const legacyProjection = projectGame(legacy.state, "actor:east");
      const upgrade = await prepareV1GameUpgrade(legacy);
      expect(upgrade.rows).toHaveLength(1);
      expect(upgrade.rows[0]).toMatchObject({
        previousHash: tableRoomV3ActiveV1GameFixture.lastEventHash,
        sequence: 3,
      });
      persistPreparedGameBatch(state.storage, upgrade);

      const upgraded = await verifyStoredGame(state.storage.sql);
      if (upgraded?.state.schemaVersion !== 2) {
        throw new Error("The fixture did not recover as canonical schema v2.");
      }
      expect(
        projectLegacyCompatibleGameV2(upgraded.state, "actor:east"),
      ).toEqual(legacyProjection);
      expect(
        state.storage.sql
          .exec<{ event_hash: string }>(
            "SELECT event_hash FROM game_events WHERE sequence <= 2 ORDER BY sequence",
          )
          .toArray()
          .map(({ event_hash }) => event_hash),
      ).toEqual(
        tableRoomV3ActiveV1GameFixture.events.map(({ eventHash }) => eventHash),
      );
      expect(
        state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      ).toBe(tableRoomV3ActiveV1GameFixture.lobbyStateVersion);

      const drawn = applyGameCommandV2(upgraded.state, "actor:west", {
        type: "game/draw",
      });
      if (!drawn.accepted) throw new Error(drawn.error.message);
      const continued = await prepareGameEventBatch(upgraded, drawn.events);
      persistPreparedGameBatch(state.storage, continued);
      await expect(verifyStoredGame(state.storage.sql)).resolves.toMatchObject({
        state: { schemaVersion: 2, sequence: 4 },
      });
    });
  });

  it("rejects reuse of a committed prepared batch through event sequence uniqueness", async () => {
    const stub = tableRoom(`authority-stale-batch-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      installActiveV3Fixture(sql);
      migrateTableRoomStorageToV6(state.storage);
      const legacy = await verifyStoredGame(sql);
      if (legacy === undefined) throw new Error("Fixture game is absent.");
      const upgrade = await prepareV1GameUpgrade(legacy);
      persistPreparedGameBatch(state.storage, upgrade, (transaction) => {
        transaction.exec(
          "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
        );
        transaction.exec(
          "INSERT INTO lobby_command_receipts (command_id, actor_id, request_json, response_json, created_at) VALUES ('committed-upgrade', 'actor:east', '{}', '{}', 100)",
        );
      });
      const readCommittedRows = () => ({
        checkpoint: sql.exec("SELECT * FROM canonical_game_state").toArray(),
        events: sql
          .exec("SELECT * FROM game_events ORDER BY sequence")
          .toArray(),
        receipts: sql
          .exec("SELECT * FROM lobby_command_receipts ORDER BY command_id")
          .toArray(),
        version: sql
          .exec("SELECT state_version FROM lobby_state WHERE singleton = 1")
          .one(),
      });
      const committed = readCommittedRows();
      const verified = await verifyStoredGame(sql);

      // Deliberate helper misuse: production serializes preparation through commit.
      expect(() => {
        persistPreparedGameBatch(state.storage, upgrade, (transaction) => {
          transaction.exec("DELETE FROM lobby_command_receipts");
          transaction.exec(
            "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
          );
        });
      }).toThrow("UNIQUE constraint failed: game_events.sequence");
      expect(readCommittedRows()).toEqual(committed);
      await expect(verifyStoredGame(sql)).resolves.toEqual(verified);
    });
  });

  it("rolls back the event batch and checkpoint when a related write fails", async () => {
    const stub = tableRoom(`authority-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      installActiveV3Fixture(state.storage.sql);
      migrateTableRoomStorageToV6(state.storage);
      const legacy = await verifyStoredGame(state.storage.sql);
      if (legacy === undefined) throw new Error("Fixture game is absent.");
      const upgrade = await prepareV1GameUpgrade(legacy);
      expect(() => {
        persistPreparedGameBatch(state.storage, upgrade, () => {
          state.storage.sql.exec(
            "UPDATE lobby_state SET state_version = 10 WHERE singleton = 1",
          );
          throw new Error("injected related-write failure");
        });
      }).toThrow("injected related-write failure");
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM game_events")
          .one().count,
      ).toBe(2);
      expect(
        state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      ).toBe(tableRoomV3ActiveV1GameFixture.lobbyStateVersion);
    });
  });

  it("persists private intents without a public revision and resolves the third response atomically", async () => {
    const stub = tableRoom(`authority-private-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      migrateTableRoomStorageToV6(state.storage);
      const started = startHongKongV2Game(
        {
          east: "stable:east",
          south: "stable:south",
          west: "stable:west",
          north: "stable:north",
        },
        Uint8Array.from(
          { length: 1_028 },
          (_, index) => (index * 41 + 17) & 0xff,
        ),
      );
      const genesis = await prepareGameEventBatch(undefined, [started.event]);
      persistPreparedGameBatch(state.storage, genesis);
      let verified = await verifyStoredGame(state.storage.sql);
      if (verified?.state.schemaVersion !== 2) {
        throw new Error("Fresh schema-v2 game did not persist.");
      }
      const dealer = playerForSeat(verified.state, verified.state.turn);
      const tileId = dealer.hand[0];
      if (tileId === undefined) throw new Error("Dealer hand is empty.");
      const discarded = applyGameCommandV2(verified.state, dealer.actorId, {
        type: "game/discard",
        tileId,
      });
      if (!discarded.accepted) throw new Error(discarded.error.message);
      const opened = await prepareGameEventBatch(verified, discarded.events);
      persistPreparedGameBatch(state.storage, opened, (sql) => {
        sql.exec(
          "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
        );
      });
      verified = await verifyStoredGame(state.storage.sql);
      if (
        verified?.state.schemaVersion !== 2 ||
        verified.state.reactionWindow === null
      ) {
        throw new Error("Reaction window did not persist.");
      }
      const responderSeats = verified.state.reactionWindow.responderOrder;
      const observingActor = playerForSeat(
        verified.state,
        responderSeats[1],
      ).actorId;
      const beforePrivateIntent = projectGameV2(verified.state, observingActor);

      for (const [index, responderSeat] of responderSeats.entries()) {
        const windowId = verified.state.reactionWindow?.id;
        if (windowId === undefined) {
          throw new Error("Reaction window closed before all responses.");
        }
        const response = applyGameCommandV2(
          verified.state,
          playerForSeat(verified.state, responderSeat).actorId,
          { type: "game/react", response: { type: "pass" }, windowId },
        );
        if (!response.accepted) throw new Error(response.error.message);
        expect(response.events.map(({ type }) => type)).toEqual(
          index === 2
            ? ["game/reaction-intent-submitted", "game/reaction-resolved"]
            : ["game/reaction-intent-submitted"],
        );
        const batch = await prepareGameEventBatch(verified, response.events);
        persistPreparedGameBatch(
          state.storage,
          batch,
          index === 2
            ? (sql) => {
                sql.exec(
                  "UPDATE lobby_state SET state_version = state_version + 1 WHERE singleton = 1",
                );
              }
            : undefined,
        );
        verified = await verifyStoredGame(state.storage.sql);
        if (verified?.state.schemaVersion !== 2) {
          throw new Error("Reaction response did not persist.");
        }
        const stateVersion = state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version;
        expect(stateVersion).toBe(index === 2 ? 2 : 1);
        if (index === 0) {
          expect(projectGameV2(verified.state, observingActor)).toEqual(
            beforePrivateIntent,
          );
        }
      }
      expect(verified.state.reactionWindow).toBeNull();
    });
  });

  it("fails closed on a corrupted permanent hash", async () => {
    const stub = tableRoom(`authority-corrupt-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      installActiveV3Fixture(state.storage.sql);
      migrateTableRoomStorageToV6(state.storage);
      state.storage.sql.exec(
        "UPDATE game_events SET event_hash = ? WHERE sequence = 2",
        "0".repeat(64),
      );
      await expect(verifyStoredGame(state.storage.sql)).rejects.toThrow(
        "hash verification failed",
      );
    });
  });
});
