import {
  HONG_KONG_V1_RANDOM_BYTES,
  startHongKongV1Game,
} from "@mahjong/rules-hong-kong";
import { activateTableConnection } from "../../src/worker/durable-objects/table-room/table-connection-application.js";
import { activateAccessSession } from "../../src/worker/durable-objects/table-room/table-access-application.js";
import { SqliteTableAccessStore } from "../../src/worker/durable-objects/table-room/table-access-store.js";
import { botWorkTarget } from "../../src/worker/durable-objects/table-room/table-bot-policy.js";
import { tableGameDeadline } from "../../src/worker/durable-objects/table-room/table-room-game-engine.js";
import {
  readDeadlineCompletion,
  scheduleDeadline,
} from "../../src/worker/durable-objects/table-room/deadline-queue.js";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import { SqliteTableConnectionStore } from "../../src/worker/durable-objects/table-room/table-connection-store.js";

it("rejects malformed persisted grant authority before a socket can use it", async () => {
  const room = (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(`grant-${crypto.randomUUID()}`);
  await runInDurableObject(room, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO connection_grants (connection_generation, actor_id, display_name, instance_id, table_id, binding_generation, binding_proof, session_generation, expires_at) VALUES ('connection', 'actor:east', 'East', 'instance', 'table', 1, ?, 1, 1000)",
      "P".repeat(43),
    );
    const store = new SqliteTableConnectionStore(state.storage);
    expect(store.grant("connection")?.actorId).toBe("actor:east");
    state.storage.sql.exec(
      "UPDATE connection_grants SET session_generation = -1 WHERE connection_generation = 'connection'",
    );
    expect(() => store.grant("connection")).toThrow(
      "Persisted connection grant is malformed",
    );
  });
});

function controllerFixture(state: DurableObjectState, autopilot: boolean) {
  const game = startHongKongV1Game(
    { east: "east", south: "south", west: "west", north: "north" },
    new Uint8Array(HONG_KONG_V1_RANDOM_BYTES),
  ).state;
  const player = [
    game.players.east,
    game.players.south,
    game.players.west,
    game.players.north,
  ].find(({ seat }) => seat === game.turn);
  if (player === undefined) throw new Error("Missing current actor");
  const actorId = player.actorId;
  const sql = state.storage.sql;
  sql.exec(
    "INSERT INTO table_record (singleton,table_id,owner_actor_id,created_at,instance_id,binding_generation,binding_proof,binding_operation_id) VALUES (1,'table',?,100,'instance',1,?,'binding')",
    actorId,
    "P".repeat(43),
  );
  sql.exec(
    "INSERT INTO members (actor_id,display_name,role,joined_at) VALUES (?,'Player','owner',100)",
    actorId,
  );
  sql.exec(
    "INSERT INTO lobby_seats (seat,actor_id,display_name,ready) VALUES ('east',?,'Player',1)",
    actorId,
  );
  sql.exec(
    "INSERT INTO player_automation (actor_id,connection_generation,autopilot,updated_at) VALUES (?,3,?,100)",
    actorId,
    Number(autopilot),
  );
  sql.exec(
    "INSERT INTO actor_sessions (actor_id,session_generation,activated_at) VALUES (?,1,100)",
    actorId,
  );
  const target = botWorkTarget(game, actorId);
  if (target === undefined) throw new Error("Missing bot work target");
  if (autopilot)
    sql.exec(
      "INSERT INTO bot_work (actor_id,target,command_id,due_at,controller_generation) VALUES (?,?,'substitute',500,3)",
      actorId,
      target,
    );
  const deadline = tableGameDeadline(game);
  if (deadline?.kind !== "turn") throw new Error("Expected turn deadline");
  scheduleDeadline(sql, {
    deadlineId: deadline.deadlineId,
    dueAt: 1000,
    kind: "turn",
    payload: deadline.payload,
    status: "pending",
    targetGeneration: deadline.targetGeneration,
  });
  return {
    game,
    actorId,
    deadlineId: deadline.deadlineId,
    grant: {
      actorId,
      displayName: "Player",
      tableId: "table",
      instanceId: "instance",
      bindingGeneration: 1,
      bindingProof: "P".repeat(43),
      sessionGeneration: 1,
      expiresAt: 1000,
    },
  };
}

it("rolls back grant, HUMAN restoration and cancelled substitute work together when revision persistence fails", async () => {
  const room = (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(`restore-${crypto.randomUUID()}`);
  await runInDurableObject(room, (_instance, state) => {
    const { game, actorId, grant } = controllerFixture(state, true);
    const store = new SqliteTableConnectionStore(state.storage);
    state.storage.sql.exec(
      "CREATE TRIGGER fail_controller_version BEFORE UPDATE ON lobby_state BEGIN SELECT RAISE(ABORT,'injected controller version failure'); END",
    );
    const connect = () =>
      activateTableConnection(store, grant, "new-connection", {
        now: 200,
        game,
        createCommandId: () => "unused",
      });
    expect(connect).toThrow("injected controller version failure");
    expect(store.grant("new-connection")).toBeUndefined();
    expect(store.controllerSnapshot()).toMatchObject({
      controls: [{ actorId, controller: "BOT", generation: 3 }],
      jobs: [{ actorId, commandId: "substitute", controllerGeneration: 3 }],
    });
    state.storage.sql.exec("DROP TRIGGER fail_controller_version");
    expect(connect()).toBe(true);
    expect(store.grant("new-connection")?.actorId).toBe(actorId);
    expect(store.controllerSnapshot()).toMatchObject({
      controls: [{ actorId, controller: "HUMAN", generation: 4 }],
      jobs: [],
    });
  });
});

it("rolls back logout session promotion, controller handoff, turn cancellation and new work together", async () => {
  const room = (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(`logout-${crypto.randomUUID()}`);
  await runInDurableObject(room, (_instance, state) => {
    const { game, actorId, deadlineId, grant } = controllerFixture(
      state,
      false,
    );
    const store = new SqliteTableAccessStore(state.storage);
    state.storage.sql.exec(
      "CREATE TRIGGER fail_controller_version BEFORE UPDATE ON lobby_state BEGIN SELECT RAISE(ABORT,'injected controller version failure'); END",
    );
    const logout = () =>
      activateAccessSession(
        store,
        { ...grant, sessionGeneration: 2, departure: true },
        {
          now: 200,
          game,
          observations: [{ actorId, expiresAt: 1000 }],
          createCommandId: () => "logout-substitute",
        },
      );
    expect(logout).toThrow("injected controller version failure");
    expect(store.sessionGeneration(actorId)).toBe(1);
    expect(store.controllerSnapshot()).toMatchObject({
      controls: [{ actorId, controller: "HUMAN", generation: 3 }],
      jobs: [],
    });
    expect(
      readDeadlineCompletion(state.storage.sql, deadlineId).deadline?.status,
    ).toBe("pending");
    state.storage.sql.exec("DROP TRIGGER fail_controller_version");
    expect(logout()).toMatchObject({
      departed: true,
      replaceActorSockets: actorId,
    });
    expect(store.sessionGeneration(actorId)).toBe(2);
    expect(store.controllerSnapshot()).toMatchObject({
      controls: [{ actorId, controller: "BOT", generation: 4 }],
      jobs: [
        {
          actorId,
          commandId: "logout-substitute",
          controllerGeneration: 4,
          dueAt: 950,
        },
      ],
    });
    expect(
      readDeadlineCompletion(state.storage.sql, deadlineId).deadline?.status,
    ).toBe("cancelled");
  });
});
