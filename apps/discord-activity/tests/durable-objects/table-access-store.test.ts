import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import {
  applyAccessBinding,
  type AccessTable,
} from "../../src/worker/durable-objects/table-room/table-access-application.js";
import { SqliteTableAccessStore } from "../../src/worker/durable-objects/table-room/table-access-store.js";

function tableRoom(): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(`access-store-${crypto.randomUUID()}`);
}

const table: AccessTable = {
  tableId: "table",
  ownerActorId: "owner",
  instanceId: "instance",
  bindingGeneration: 1,
  bindingProof: "P".repeat(43),
  bindingOperationId: "create",
};

function createTable(store: SqliteTableAccessStore) {
  return applyAccessBinding(
    store,
    {
      actor: { id: "owner", displayName: "Owner" },
      deadlineAt: 500,
      instanceId: "instance",
      intent: { kind: "create" },
      operationId: "create",
    },
    { tableId: "table", now: 100, bindingProof: "P".repeat(43) },
  );
}

describe("table access SQLite atomic commits", () => {
  it("keeps admission pending when owner insertion fails after table insertion", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const store = new SqliteTableAccessStore(state.storage);
      state.storage.sql.exec(
        "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES ('owner', 'Owner', 'owner', 1)",
      );
      expect(() => createTable(store)).toThrow();
      expect(store.table()).toBeUndefined();
      expect(store.receipt("create")).toMatchObject({
        status: "pending",
        result: undefined,
      });
      state.storage.sql.exec("DELETE FROM members WHERE actor_id = 'owner'");
      expect(createTable(store).status).toBe(200);
      expect(store.receipt("create")?.status).toBe("applied");
    });
  });

  it("rolls back resume capability, binding, and session reset if receipt completion fails", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const store = new SqliteTableAccessStore(state.storage);
      createTable(store);
      store.commit({
        kind: "activate-session",
        actorId: "owner",
        sessionGeneration: 1,
        now: 100,
      });
      store.commit({
        kind: "issue-capability",
        capabilityId: "cap",
        capability: {
          kind: "resume",
          subjectActorId: "owner",
          secretHash: "D".repeat(43),
          expectedBindingGeneration: 1,
          expiresAt: 1000,
          consumedActorId: null,
          consumedOperationId: null,
        },
      });
      store.commit({
        kind: "admit-binding",
        operationId: "resume",
        requestJson: "{}",
        now: 200,
      });
      state.storage.sql.exec(
        "CREATE TRIGGER fail_receipt BEFORE UPDATE ON binding_receipts WHEN NEW.operation_id = 'resume' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
      );
      expect(() =>
        store.commit({
          kind: "complete-binding",
          operationId: "resume",
          now: 200,
          status: "applied",
          result: { status: 200, body: {} },
          change: {
            kind: "resume",
            capabilityId: "cap",
            table: {
              ...table,
              instanceId: "next",
              bindingGeneration: 2,
              bindingProof: "N".repeat(43),
              bindingOperationId: "resume",
            },
          },
        }),
      ).toThrow();
      expect(store.table()).toEqual(table);
      expect(store.sessionGeneration("owner")).toBe(1);
      expect(store.capability("cap")).toMatchObject({
        consumedActorId: null,
        consumedOperationId: null,
      });
      expect(store.receipt("resume")).toMatchObject({
        status: "pending",
        result: undefined,
      });
    });
  });

  it("rolls back invitation consumption if membership fails and never advances the public version", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const store = new SqliteTableAccessStore(state.storage);
      createTable(store);
      store.commit({
        kind: "issue-capability",
        capabilityId: "cap",
        capability: {
          kind: "invitation",
          subjectActorId: "owner",
          secretHash: "D".repeat(43),
          expectedBindingGeneration: 1,
          expiresAt: 1000,
          consumedActorId: null,
          consumedOperationId: null,
        },
      });
      expect(() =>
        store.commit({
          kind: "redeem-invitation",
          capabilityId: "cap",
          actor: { id: "owner", displayName: "Owner" },
          addMember: true,
          now: 200,
        }),
      ).toThrow();
      expect(store.capability("cap")?.consumedActorId).toBeNull();
      expect(
        state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      ).toBe(0);
    });
  });

  it("reports duplicate admission without overwriting the original operation", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const store = new SqliteTableAccessStore(state.storage);
      expect(
        store.commit({
          kind: "admit-binding",
          operationId: "operation",
          requestJson: "original",
          now: 100,
        }),
      ).toEqual({ kind: "committed" });
      expect(
        store.commit({
          kind: "admit-binding",
          operationId: "operation",
          requestJson: "collision",
          now: 200,
        }),
      ).toEqual({ kind: "conflict" });
      expect(store.receipt("operation")?.requestJson).toBe("original");
    });
  });
});

describe("persisted table access validation", () => {
  it.each([
    "UPDATE table_record SET binding_generation = 'not-a-number'",
    "UPDATE table_record SET binding_generation = 1.5",
    "UPDATE table_record SET owner_actor_id = ''",
    "UPDATE table_record SET instance_id = ''",
    "UPDATE table_record SET binding_proof = 'not-a-proof'",
    "UPDATE table_record SET binding_operation_id = ''",
  ])("fails closed for malformed table authority: %s", async (statement) => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const store = new SqliteTableAccessStore(state.storage);
      createTable(store);
      state.storage.sql.exec(statement);
      expect(() => store.table()).toThrow(
        "Invalid persisted table access record.",
      );
    });
  });

  it.each([
    "UPDATE capabilities SET expected_binding_generation = 'not-a-number'",
    "UPDATE capabilities SET expires_at = 'not-a-time'",
    "UPDATE capabilities SET expires_at = -1",
    "UPDATE capabilities SET subject_actor_id = ''",
    "UPDATE capabilities SET secret_hash = 'not-a-digest'",
    "UPDATE capabilities SET consumed_actor_id = ''",
    "UPDATE capabilities SET consumed_operation_id = ''",
  ])(
    "fails closed for malformed capability authority: %s",
    async (statement) => {
      await runInDurableObject(tableRoom(), (_instance, state) => {
        const store = new SqliteTableAccessStore(state.storage);
        store.commit({
          kind: "issue-capability",
          capabilityId: "cap",
          capability: {
            kind: "resume",
            subjectActorId: "owner",
            secretHash: "D".repeat(43),
            expectedBindingGeneration: 1,
            expiresAt: 1000,
            consumedActorId: null,
            consumedOperationId: null,
          },
        });
        state.storage.sql.exec(statement);
        expect(() => store.capability("cap")).toThrow(
          "Invalid persisted capability record.",
        );
      });
    },
  );

  it.each(["not-a-number", -1, 1.5, 9_007_199_254_740_992])(
    "fails closed for malformed session generation %s",
    async (generation) => {
      await runInDurableObject(tableRoom(), (_instance, state) => {
        const store = new SqliteTableAccessStore(state.storage);
        state.storage.sql.exec(
          "INSERT INTO actor_sessions (actor_id, session_generation, activated_at) VALUES ('owner', ?, 100)",
          generation,
        );
        expect(() => store.sessionGeneration("owner")).toThrow(
          "Invalid persisted session generation.",
        );
      });
    },
  );

  it("rejects malformed or extended stored binding responses instead of replaying their contents", async () => {
    await runInDurableObject(tableRoom(), (_instance, state) => {
      const store = new SqliteTableAccessStore(state.storage);
      createTable(store);
      const response = store.receipt("create")?.result;
      expect(response?.status).toBe(200);
      const invalidBodies = [
        "not json",
        JSON.stringify({
          version: 1,
          tableId: "table",
          bindingGeneration: "1",
          bindingProof: "P".repeat(43),
          role: "owner",
        }),
        JSON.stringify({
          version: 1,
          tableId: "table",
          bindingGeneration: 1,
          bindingProof: "P".repeat(43),
          role: "owner",
          canonicalState: { hidden: true },
        }),
      ];
      for (const body of invalidBodies) {
        state.storage.sql.exec(
          "UPDATE binding_receipts SET response_json = ? WHERE operation_id = 'create'",
          body,
        );
        expect(() => store.receipt("create")).toThrow(
          /Invalid persisted .*binding receipt/u,
        );
      }
      state.storage.sql.exec(
        "UPDATE binding_receipts SET status = 'pending', response_json = NULL, http_status = 0 WHERE operation_id = 'create'",
      );
      expect(store.receipt("create")?.result).toBeUndefined();
      expect(createTable(store)).toEqual(response);
    });
  });
});
