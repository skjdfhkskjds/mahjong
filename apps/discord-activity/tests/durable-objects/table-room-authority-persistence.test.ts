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
  migrateTableRoomStorageToV4,
  persistPreparedGameBatch,
  prepareGameEventBatch,
  prepareV1GameUpgrade,
  verifyStoredGame,
} from "../../src/worker/durable-objects/table-room/table-room-game-store.js";
import { tableRoomV1Schema } from "../fixtures/table-room-v1-schema.js";
import { tableRoomV3ActiveV1GameFixture } from "../fixtures/table-room-v3-active-v1-game.js";

const ALL_TABLES = [
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

describe("TableRoom authority persistence primitives", () => {
  it("migrates the permanent v1 storage root through v4 without losing access data", async () => {
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

      migrateTableRoomStorageToV4(state.storage);

      expect(
        state.storage.sql
          .exec<{ schema_version: number }>(
            "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
          )
          .one().schema_version,
      ).toBe(4);
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

  it("migrates schema v2 through v4 without losing lobby state or receipts", async () => {
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

      migrateTableRoomStorageToV4(state.storage);

      expect(
        state.storage.sql
          .exec<{ schema_version: number }>(
            "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
          )
          .one().schema_version,
      ).toBe(4);
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
      migrateTableRoomStorageToV4(state.storage);
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

  it("rolls back the event batch and checkpoint when a related write fails", async () => {
    const stub = tableRoom(`authority-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      installActiveV3Fixture(state.storage.sql);
      migrateTableRoomStorageToV4(state.storage);
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
      migrateTableRoomStorageToV4(state.storage);
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
      migrateTableRoomStorageToV4(state.storage);
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
