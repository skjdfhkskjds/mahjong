import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";

interface Binding {
  readonly bindingGeneration: number;
  readonly bindingProof: string;
  readonly role: "owner";
  readonly tableId: string;
  readonly version: 1;
}

interface Capability {
  readonly capability: string;
  readonly expiresAt: number;
  readonly version: 1;
}

interface SnapshotMessage {
  readonly protocolVersion: number;
  readonly stateVersion: number;
  readonly type: string;
  readonly view: {
    readonly tableId: string;
    readonly viewer: {
      readonly actor: { readonly displayName: string; readonly id: string };
    };
  };
}

const owner = { displayName: "Table Owner", id: "discord:owner" } as const;
const member = { displayName: "Invited Member", id: "discord:member" } as const;

function tableRoom(name: string): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(name);
}

async function post(
  stub: DurableObjectStub<TableRoom>,
  pathname: string,
  body: object,
): Promise<Response> {
  return stub.fetch(
    new Request(`https://table-room.internal${pathname}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  );
}

async function createTable(
  stub: DurableObjectStub<TableRoom>,
  tableId: string,
  operationId = crypto.randomUUID(),
): Promise<{ readonly binding: Binding; readonly request: object }> {
  const request = {
    version: 1,
    operationId,
    instanceId: "instance-original",
    actor: owner,
    deadlineAt: Date.now() + 60_000,
    intent: { kind: "create" },
  } as const;
  const response = await post(stub, "/internal/bindings/apply", request);
  expect(response.status).toBe(200);
  const binding = await response.json<Binding>();
  expect(binding).toMatchObject({
    version: 1,
    tableId,
    bindingGeneration: 1,
    role: "owner",
  });
  expect(binding.bindingProof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return { binding, request };
}

function bindingAuthorization(
  binding: Binding,
  instanceId = "instance-original",
) {
  return {
    instanceId,
    bindingGeneration: binding.bindingGeneration,
    bindingProof: binding.bindingProof,
  };
}

async function activateSession(
  stub: DurableObjectStub<TableRoom>,
  binding: Binding,
  actorId: string,
  sessionGeneration: number,
  instanceId = "instance-original",
): Promise<Response> {
  return post(stub, "/internal/sessions/activate", {
    version: 1,
    ...bindingAuthorization(binding, instanceId),
    actorId,
    sessionGeneration,
  });
}

function nextMessage(socket: WebSocket): Promise<SnapshotMessage> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(JSON.parse(String(event.data)) as SnapshotMessage);
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Snapshot parsing failed."),
          );
        }
      },
      { once: true },
    );
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
}

function displayNameHeader(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function connect(
  stub: DurableObjectStub<TableRoom>,
  binding: Binding,
  sessionGeneration: number,
  actor = owner,
  instanceId = "instance-original",
): Promise<Response> {
  return stub.fetch(
    new Request("https://table-room.internal/connect", {
      headers: {
        Upgrade: "websocket",
        "X-Mahjong-Actor-Id": actor.id,
        "X-Mahjong-Binding-Generation": String(binding.bindingGeneration),
        "X-Mahjong-Binding-Proof": binding.bindingProof,
        "X-Mahjong-Connection-Generation": crypto.randomUUID(),
        "X-Mahjong-Display-Name": displayNameHeader(actor.displayName),
        "X-Mahjong-Instance-Id": instanceId,
        "X-Mahjong-Session-Expires-At": String(Date.now() + 60_000),
        "X-Mahjong-Session-Generation": String(sessionGeneration),
        "X-Mahjong-Table-Id": binding.tableId,
      },
    }),
  );
}

describe("TableRoom authority", () => {
  it("persists a create receipt and replays it identically after eviction", async () => {
    const tableId = `create-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const operationId = crypto.randomUUID();
    const created = await createTable(stub, tableId, operationId);

    await evictDurableObject(stub);
    const replay = await post(
      stub,
      "/internal/bindings/apply",
      created.request,
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(created.binding);

    const collision = await post(stub, "/internal/bindings/apply", {
      ...created.request,
      actor: { ...owner, displayName: "Changed Owner" },
    });
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({
      error: { code: "operation-collision" },
    });

    const secondCreate = await post(stub, "/internal/bindings/apply", {
      ...created.request,
      operationId: crypto.randomUUID(),
    });
    expect(secondCreate.status).toBe(409);
    await expect(secondCreate.json()).resolves.toMatchObject({
      error: { code: "table-already-created" },
    });
  });

  it("expires only uncommitted pending receipts after their deadline", async () => {
    const expiredTableId = `expired-${crypto.randomUUID()}`;
    const expiredStub = tableRoom(expiredTableId);
    const expiredRequest = {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-expired",
      actor: owner,
      deadlineAt: 0,
      intent: { kind: "create" },
    } as const;
    const canonicalExpiredRequest = JSON.stringify({
      actor: expiredRequest.actor,
      deadlineAt: expiredRequest.deadlineAt,
      instanceId: expiredRequest.instanceId,
      intent: expiredRequest.intent,
      operationId: expiredRequest.operationId,
      version: 1,
    });
    await runInDurableObject(expiredStub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO binding_receipts (operation_id, request_json, status, response_json, http_status, created_at, updated_at) VALUES (?, ?, 'pending', NULL, 0, 0, 0)",
        expiredRequest.operationId,
        canonicalExpiredRequest,
      );
    });
    const expired = await post(
      expiredStub,
      "/internal/bindings/apply",
      expiredRequest,
    );
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "binding-expired" },
    });
    await expect(
      runInDurableObject(expiredStub, (_instance, state) => ({
        receipts: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM binding_receipts WHERE status = 'rejected'",
          )
          .one().count,
        tables: state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM table_record")
          .one().count,
      })),
    ).resolves.toEqual({ receipts: 1, tables: 0 });

    const committedTableId = `committed-${crypto.randomUUID()}`;
    const committedStub = tableRoom(committedTableId);
    const operationId = crypto.randomUUID();
    const created = await createTable(
      committedStub,
      committedTableId,
      operationId,
    );
    const committedRetry = {
      ...created.request,
      deadlineAt: 0,
    };
    const canonicalCommittedRetry = JSON.stringify({
      actor: owner,
      deadlineAt: 0,
      instanceId: "instance-original",
      intent: { kind: "create" },
      operationId,
      version: 1,
    });
    await runInDurableObject(committedStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE binding_receipts SET request_json = ?, status = 'pending', response_json = NULL, http_status = 0 WHERE operation_id = ?",
        canonicalCommittedRetry,
        operationId,
      );
    });
    const repaired = await post(
      committedStub,
      "/internal/bindings/apply",
      committedRetry,
    );
    expect(repaired.status).toBe(200);
    await expect(repaired.json()).resolves.toEqual(created.binding);
  });

  it("issues actor-bound invitations and owner-only resume capabilities", async () => {
    const tableId = `access-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();

    const invitationResponse = await post(
      stub,
      "/internal/invitations/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        invitedActorId: member.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(invitationResponse.status).toBe(200);
    const invitation = await invitationResponse.json<Capability>();
    expect(invitation.capability).toContain(`v1.${tableId}.`);

    const wrongActorActivation = await activateSession(
      stub,
      binding,
      "discord:wrong",
      1,
    );
    expect(wrongActorActivation.status).toBe(403);
    await wrongActorActivation.body?.cancel();
    const wrongActor = await post(stub, "/internal/invitations/redeem", {
      version: 1,
      ...authorization,
      actor: { displayName: "Wrong Actor", id: "discord:wrong" },
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 1,
    });
    expect(wrongActor.status).toBe(403);
    await wrongActor.body?.cancel();

    const candidateActivation = await activateSession(
      stub,
      binding,
      member.id,
      1,
    );
    expect(candidateActivation.status).toBe(403);
    await candidateActivation.body?.cancel();
    const redeemBody = {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 1,
    } as const;
    const redeemed = await post(
      stub,
      "/internal/invitations/redeem",
      redeemBody,
    );
    expect(redeemed.status).toBe(200);
    await expect(redeemed.json()).resolves.toEqual({
      version: 1,
      tableId,
      role: "member",
    });
    const memberActivation = await post(stub, "/internal/sessions/activate", {
      version: 1,
      ...authorization,
      actorId: member.id,
      sessionGeneration: 1,
    });
    await expect(memberActivation.json()).resolves.toEqual({
      version: 1,
      active: true,
      role: "member",
    });
    const invitationReplay = await post(
      stub,
      "/internal/invitations/redeem",
      redeemBody,
    );
    expect(invitationReplay.status).toBe(410);
    await invitationReplay.body?.cancel();

    const memberResume = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...authorization,
        actorId: member.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(memberResume.status).toBe(403);
    await memberResume.body?.cancel();

    const resumeResponse = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(resumeResponse.status).toBe(200);
    const resumeCapability = await resumeResponse.json<Capability>();
    const resumeRequest = {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-resumed",
      actor: owner,
      deadlineAt: Date.now() + 60_000,
      intent: { kind: "resume", capability: resumeCapability.capability },
    } as const;
    const resumedResponse = await post(
      stub,
      "/internal/bindings/apply",
      resumeRequest,
    );
    expect(resumedResponse.status).toBe(200);
    const resumed = await resumedResponse.json<Binding>();
    expect(resumed).toMatchObject({
      tableId,
      bindingGeneration: 2,
      role: "owner",
    });
    expect(resumed.bindingProof).not.toBe(binding.bindingProof);

    await evictDurableObject(stub);
    const resumeReplay = await post(
      stub,
      "/internal/bindings/apply",
      resumeRequest,
    );
    expect(resumeReplay.status).toBe(200);
    await expect(resumeReplay.json()).resolves.toEqual(resumed);

    const consumed = await post(stub, "/internal/bindings/apply", {
      ...resumeRequest,
      operationId: crypto.randomUUID(),
    });
    expect(consumed.status).toBe(410);
    await expect(consumed.json()).resolves.toMatchObject({
      error: { code: "capability-consumed" },
    });
  });

  it("serializes duplicate and competing resume operations without storing secrets", async () => {
    const tableId = `resume-race-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();
    const firstCapabilityResponse = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...bindingAuthorization(binding),
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    const firstCapability = await firstCapabilityResponse.json<Capability>();
    const duplicateRequest = {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-duplicate-resume",
      actor: owner,
      deadlineAt: Date.now() + 60_000,
      intent: { kind: "resume", capability: firstCapability.capability },
    } as const;

    const duplicateResponses = await Promise.all([
      post(stub, "/internal/bindings/apply", duplicateRequest),
      post(stub, "/internal/bindings/apply", duplicateRequest),
    ]);
    expect(duplicateResponses.map(({ status }) => status)).toEqual([200, 200]);
    const duplicateResults = await Promise.all(
      duplicateResponses.map((response) => response.json<Binding>()),
    );
    expect(duplicateResults[1]).toEqual(duplicateResults[0]);
    const resumed = duplicateResults[0];
    if (resumed === undefined) throw new Error("Resume result is missing.");

    const storedRequest = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ request_json: string }>(
            "SELECT request_json FROM binding_receipts WHERE operation_id = ?",
            duplicateRequest.operationId,
          )
          .one().request_json,
    );
    const capabilitySecret = firstCapability.capability.split(".").at(-1);
    expect(storedRequest).not.toContain(firstCapability.capability);
    expect(capabilitySecret).toBeDefined();
    expect(storedRequest).not.toContain(capabilitySecret ?? "");

    const resumedActivation = await activateSession(
      stub,
      resumed,
      owner.id,
      1,
      "instance-duplicate-resume",
    );
    expect(resumedActivation.status).toBe(200);
    await resumedActivation.body?.cancel();

    const secondCapabilityResponse = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...bindingAuthorization(resumed, "instance-duplicate-resume"),
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    const secondCapability = await secondCapabilityResponse.json<Capability>();
    const firstOperation = {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-competing-a",
      actor: owner,
      deadlineAt: Date.now() + 60_000,
      intent: { kind: "resume", capability: secondCapability.capability },
    } as const;
    const secondOperation = {
      ...firstOperation,
      operationId: crypto.randomUUID(),
      instanceId: "instance-competing-b",
    } as const;
    const competingResponses = await Promise.all([
      post(stub, "/internal/bindings/apply", firstOperation),
      post(stub, "/internal/bindings/apply", secondOperation),
    ]);
    expect(competingResponses.map(({ status }) => status).toSorted()).toEqual([
      200, 410,
    ]);
    const winnerIndex = competingResponses.findIndex(
      ({ status }) => status === 200,
    );
    const winningResponse = competingResponses[winnerIndex];
    if (winningResponse === undefined)
      throw new Error("A resume operation did not win.");
    const winningBinding = await winningResponse.json<Binding>();
    const winningRequest = winnerIndex === 0 ? firstOperation : secondOperation;
    await competingResponses[1 - winnerIndex]?.body?.cancel();
    const replay = await post(stub, "/internal/bindings/apply", winningRequest);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(winningBinding);
  });

  it("consumes an invitation exactly once under concurrent redemption", async () => {
    const tableId = `invite-race-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();
    const invitationResponse = await post(
      stub,
      "/internal/invitations/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        invitedActorId: member.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    const invitation = await invitationResponse.json<Capability>();
    const candidateActivation = await activateSession(
      stub,
      binding,
      member.id,
      1,
    );
    expect(candidateActivation.status).toBe(403);
    await candidateActivation.body?.cancel();
    const redeemBody = {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 1,
    } as const;
    const responses = await Promise.all([
      post(stub, "/internal/invitations/redeem", redeemBody),
      post(stub, "/internal/invitations/redeem", redeemBody),
    ]);
    expect(responses.map(({ status }) => status).toSorted()).toEqual([
      200, 410,
    ]);
    for (const response of responses) await response.body?.cancel();
  });

  it("rejects stale capability mutations after session replacement", async () => {
    const tableId = `stale-capability-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);

    const ownerFirst = await activateSession(stub, binding, owner.id, 1);
    expect(ownerFirst.status).toBe(200);
    await ownerFirst.body?.cancel();
    const invitationResponse = await post(
      stub,
      "/internal/invitations/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        invitedActorId: member.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(invitationResponse.status).toBe(200);
    const invitation = await invitationResponse.json<Capability>();

    const memberFirst = await activateSession(stub, binding, member.id, 1);
    expect(memberFirst.status).toBe(403);
    await memberFirst.body?.cancel();
    const ownerReplacement = await activateSession(stub, binding, owner.id, 2);
    expect(ownerReplacement.status).toBe(200);
    await ownerReplacement.body?.cancel();

    const staleCreate = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(staleCreate.status).toBe(409);
    await expect(staleCreate.json()).resolves.toMatchObject({
      error: { code: "stale-session-generation" },
    });
    await expect(
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM capabilities",
            )
            .one().count,
      ),
    ).resolves.toBe(1);

    const memberReplacement = await activateSession(
      stub,
      binding,
      member.id,
      2,
    );
    expect(memberReplacement.status).toBe(403);
    await memberReplacement.body?.cancel();
    const staleRedeem = await post(stub, "/internal/invitations/redeem", {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 1,
    });
    expect(staleRedeem.status).toBe(409);
    await expect(staleRedeem.json()).resolves.toMatchObject({
      error: { code: "stale-session-generation" },
    });

    const currentRedeem = await post(stub, "/internal/invitations/redeem", {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 2,
    });
    expect(currentRedeem.status).toBe(200);
    await currentRedeem.body?.cancel();
  });

  it("accepts a fresh session generation after resume resets the binding epoch", async () => {
    const tableId = `resume-session-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);
    for (const sessionGeneration of [1, 2, 3]) {
      const activation = await post(stub, "/internal/sessions/activate", {
        version: 1,
        ...authorization,
        actorId: owner.id,
        sessionGeneration,
      });
      expect(activation.status).toBe(200);
      await activation.body?.cancel();
    }
    const capabilityResponse = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 3,
      },
    );
    const capability = await capabilityResponse.json<Capability>();
    const resumeResponse = await post(stub, "/internal/bindings/apply", {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-new-session-epoch",
      actor: owner,
      deadlineAt: Date.now() + 60_000,
      intent: { kind: "resume", capability: capability.capability },
    });
    const resumed = await resumeResponse.json<Binding>();
    const freshActivation = await post(stub, "/internal/sessions/activate", {
      version: 1,
      ...bindingAuthorization(resumed, "instance-new-session-epoch"),
      actorId: owner.id,
      sessionGeneration: 1,
    });
    expect(freshActivation.status).toBe(200);
    await expect(freshActivation.json()).resolves.toEqual({
      version: 1,
      active: true,
      role: "owner",
    });
  });

  it("refuses to open an unsupported persisted schema version", async () => {
    const tableId = `schema-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE storage_metadata SET schema_version = 2 WHERE singleton = 1",
      );
    });
    await evictDurableObject(stub);
    await expect(
      post(stub, "/internal/bindings/apply", {
        version: 1,
        operationId: crypto.randomUUID(),
        instanceId: "instance-schema",
        actor: owner,
        deadlineAt: Date.now() + 60_000,
        intent: { kind: "create" },
      }),
    ).rejects.toThrow(/Unsupported TableRoom storage schema version/u);
  });

  it("checks active session generation on connect and every socket message", async () => {
    const tableId = `socket-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);

    const firstSession = 1;
    const activated = await post(stub, "/internal/sessions/activate", {
      version: 1,
      ...authorization,
      actorId: owner.id,
      sessionGeneration: firstSession,
    });
    expect(activated.status).toBe(200);
    await activated.body?.cancel();

    const upgrade = await connect(stub, binding, firstSession);
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    if (socket === null)
      throw new Error("WebSocket upgrade returned no socket.");
    const initialMessage = nextMessage(socket);
    socket.accept();
    const initial = await initialMessage;
    expect(initial).toMatchObject({
      type: "table/snapshot",
      view: {
        tableId,
        viewer: { actor: owner },
      },
    });

    const secondSession = 2;
    const replaced = await post(stub, "/internal/sessions/activate", {
      version: 1,
      ...authorization,
      actorId: owner.id,
      sessionGeneration: secondSession,
    });
    expect(replaced.status).toBe(200);
    await replaced.body?.cancel();

    const close = nextClose(socket);
    await expect(close).resolves.toMatchObject({ code: 4001 });

    const staleUpgrade = await connect(stub, binding, firstSession);
    expect(staleUpgrade.status).toBe(403);
    await staleUpgrade.body?.cancel();

    const currentUpgrade = await connect(stub, binding, secondSession);
    expect(currentUpgrade.status).toBe(101);
    const currentSocket = currentUpgrade.webSocket;
    expect(currentSocket).not.toBeNull();
    if (currentSocket === null)
      throw new Error("WebSocket upgrade returned no socket.");
    const currentInitialMessage = nextMessage(currentSocket);
    currentSocket.accept();
    const currentInitial = await currentInitialMessage;

    await evictDurableObject(stub);
    const resyncMessage = nextMessage(currentSocket);
    currentSocket.send(
      JSON.stringify({ lastSeenStateVersion: 0, type: "table/resync" }),
    );
    expect(await resyncMessage).toEqual(currentInitial);
    currentSocket.close(1000, "test complete");
  });
});
