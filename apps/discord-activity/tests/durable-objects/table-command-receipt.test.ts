import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import { executeTableCommand } from "../../src/worker/durable-objects/table-room/table-command-application.js";
import { SqliteTableCommandStore } from "../../src/worker/durable-objects/table-room/table-command-store.js";
import { canonicalTableRequest } from "../../src/worker/durable-objects/table-room/table-room-protocol.js";

function tableRoom(): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(`command-receipt-${crypto.randomUUID()}`);
}

const envelope = {
  commandId: "claim",
  expectedStateVersion: 0,
  command: { type: "lobby/claim-seat", seat: "east" },
} as const;
const request = canonicalTableRequest(envelope);
const response = {
  type: "table/receipt",
  protocolVersion: 2,
  commandId: "claim",
  outcome: "applied",
  stateVersion: 1,
} as const;

// Permanent examples of the actual protocol-v1 lobby receipt encoding. They
// remain readable for operation collisions; current clients still speak v2.
const legacyRequest =
  '{"command":{"type":"lobby/claim-seat","seat":"east"},"commandId":"claim","expectedStateVersion":0,"protocolVersion":1,"type":"table/command"}';
const legacyResponse =
  '{"type":"table/receipt","protocolVersion":1,"commandId":"claim","outcome":"applied","stateVersion":1}';

function insertReceipt(
  sql: SqlStorage,
  requestJson = request,
  responseJson = JSON.stringify(response),
  actorId = "actor:east",
) {
  sql.exec(
    "INSERT INTO lobby_command_receipts (command_id, actor_id, request_json, response_json, created_at) VALUES ('claim', ?, ?, ?, 100)",
    actorId,
    requestJson,
    responseJson,
  );
}

function insertMember(sql: SqlStorage) {
  sql.exec(
    "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES ('actor:east', 'East', 'member', 100)",
  );
}

describe("stored table command receipt validation", () => {
  it("preserves exact valid stored bytes and replays a current receipt without mutation", async () => {
    await runInDurableObject(tableRoom(), async (_instance, state) => {
      insertMember(state.storage.sql);
      insertReceipt(state.storage.sql);
      const store = new SqliteTableCommandStore(state.storage);
      expect(store.receipt("claim")).toEqual({
        actorId: "actor:east",
        requestJson: request,
        response: JSON.stringify(response),
      });
      const result = await executeTableCommand(store, {
        actorId: "actor:east",
        envelope,
        now: 200,
        observations: [],
        randomBytes: (length) => new Uint8Array(length),
        authority: { kind: "HUMAN", generation: 0 },
        createCommandId: () => "unused-job",
        newBotActorId: () => "bot:00000000-0000-0000-0000-000000000001",
      });
      expect(result).toMatchObject({
        applied: false,
        broadcast: false,
        response: JSON.stringify(response),
      });
      expect(
        state.storage.sql
          .exec("SELECT command_id FROM lobby_command_receipts")
          .toArray(),
      ).toHaveLength(1);
    });
  });

  it("retains protocol-v1 receipt bytes and reports collision for a protocol-v2 reuse", async () => {
    await runInDurableObject(tableRoom(), async (_instance, state) => {
      insertMember(state.storage.sql);
      insertReceipt(state.storage.sql, legacyRequest, legacyResponse);
      const store = new SqliteTableCommandStore(state.storage);
      expect(store.receipt("claim")).toEqual({
        actorId: "actor:east",
        requestJson: legacyRequest,
        response: legacyResponse,
      });
      const result = await executeTableCommand(store, {
        actorId: "actor:east",
        envelope,
        now: 200,
        observations: [],
        randomBytes: (length) => new Uint8Array(length),
        authority: { kind: "HUMAN", generation: 0 },
        createCommandId: () => "unused-job",
        newBotActorId: () => "bot:00000000-0000-0000-0000-000000000001",
      });
      expect(JSON.parse(result.response)).toMatchObject({
        protocolVersion: 2,
        outcome: "rejected",
        error: { code: "command-id-collision" },
      });
      expect(store.receipt("claim")?.response).toBe(legacyResponse);
    });
  });

  it("accepts the historical closed rejection shape", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const rejection = JSON.stringify({
        ...response,
        outcome: "rejected",
        error: {
          code: "stale-state-version",
          message: "The table state changed; resynchronize and retry.",
        },
      });
      insertReceipt(state.storage.sql, request, rejection);
      expect(
        new SqliteTableCommandStore(state.storage).receipt("claim")?.response,
      ).toBe(rejection);
    });
  });

  it.each([
    ["non-JSON", "not json"],
    ["non-record", "null"],
    [
      "extended private fields",
      JSON.stringify({ ...response, canonicalState: { concealed: [1, 2] } }),
    ],
    [
      "wrong message type",
      JSON.stringify({ ...response, type: "table/snapshot" }),
    ],
    [
      "unsupported protocol",
      JSON.stringify({ ...response, protocolVersion: 99 }),
    ],
    ["wrong operation ID", JSON.stringify({ ...response, commandId: "other" })],
    ["invalid outcome", JSON.stringify({ ...response, outcome: "pending" })],
    ["negative version", JSON.stringify({ ...response, stateVersion: -1 })],
    ["non-integer version", JSON.stringify({ ...response, stateVersion: 1.5 })],
    ["string version", JSON.stringify({ ...response, stateVersion: "1" })],
    [
      "error on accepted receipt",
      JSON.stringify({
        ...response,
        error: { code: "unexpected", message: "Unexpected" },
      }),
    ],
    [
      "missing rejection error",
      JSON.stringify({ ...response, outcome: "rejected" }),
    ],
    [
      "extended rejection error",
      JSON.stringify({
        ...response,
        outcome: "rejected",
        error: { code: "rejected", message: "Rejected", canonicalState: {} },
      }),
    ],
    [
      "oversized payload",
      JSON.stringify({ ...response, privateData: "x".repeat(16_384) }),
    ],
    [
      "duplicate keys",
      JSON.stringify(response).replace(
        '"stateVersion":1',
        '"stateVersion":{"hidden":true},"stateVersion":1',
      ),
    ],
  ])("fails closed before replaying %s", async (_label, malformedResponse) => {
    await runInDurableObject(tableRoom(), async (_instance, state) => {
      insertMember(state.storage.sql);
      insertReceipt(state.storage.sql, request, malformedResponse);
      const store = new SqliteTableCommandStore(state.storage);
      await expect(
        executeTableCommand(store, {
          actorId: "actor:east",
          envelope,
          now: 200,
          observations: [],
          randomBytes: (length) => new Uint8Array(length),
          authority: { kind: "HUMAN", generation: 0 },
          createCommandId: () => "unused-job",
          newBotActorId: () => "bot:00000000-0000-0000-0000-000000000001",
        }),
      ).rejects.toThrow("Persisted command receipt is malformed.");
      expect(
        state.storage.sql.exec("SELECT actor_id FROM lobby_seats").toArray(),
      ).toEqual([]);
    });
  });

  it.each([
    "{}",
    request.replace('"protocolVersion":2', '"protocolVersion":99'),
    request.replace('"commandId":"claim"', '"commandId":"other"'),
    request.replace('"seat":"east"', '"seat":"invalid"'),
  ])("rejects malformed persisted request %s", async (malformedRequest) => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      insertReceipt(state.storage.sql, malformedRequest);
      expect(() =>
        new SqliteTableCommandStore(state.storage).receipt("claim"),
      ).toThrow("Persisted command receipt is malformed.");
    });
  });

  it.each(["", "x".repeat(97), "actor\u0000hidden"])(
    "rejects malformed receipt actor %s",
    async (actorId) => {
      await runInDurableObject(tableRoom(), (_instance, state) => {
        insertReceipt(
          state.storage.sql,
          request,
          JSON.stringify(response),
          actorId,
        );
        expect(() =>
          new SqliteTableCommandStore(state.storage).receipt("claim"),
        ).toThrow("Persisted command receipt is malformed.");
      });
    },
  );
});

describe("stored command authority validation", () => {
  it.each([
    "UPDATE lobby_state SET state_version = 0.5",
    "UPDATE lobby_state SET state_version = 'invalid'",
    "UPDATE members SET display_name = ''",
  ])("rejects malformed command authority: %s", async (statement) => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      insertMember(state.storage.sql);
      state.storage.sql.exec(statement);
      expect(() =>
        new SqliteTableCommandStore(state.storage).commandState("actor:east"),
      ).toThrow("Persisted command authority is malformed.");
    });
  });

  it("rejects a malformed persisted seat actor before it enters application policy", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      insertMember(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES ('east', '', 'East', 0)",
      );
      expect(() =>
        new SqliteTableCommandStore(state.storage).commandState("actor:east"),
      ).toThrow("Persisted command seat is malformed.");
    });
  });
});
