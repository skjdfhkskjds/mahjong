import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
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
        "X-Mahjong-Display-Name": actor.displayName,
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

  it("issues actor-bound invitations and owner-only resume capabilities", async () => {
    const tableId = `access-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);

    const invitationResponse = await post(
      stub,
      "/internal/invitations/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        invitedActorId: member.id,
        now: Date.now(),
      },
    );
    expect(invitationResponse.status).toBe(200);
    const invitation = await invitationResponse.json<Capability>();
    expect(invitation.capability).toContain(`v1.${tableId}.`);

    const wrongActor = await post(stub, "/internal/invitations/redeem", {
      version: 1,
      ...authorization,
      actor: { displayName: "Wrong Actor", id: "discord:wrong" },
      capability: invitation.capability,
      now: Date.now(),
    });
    expect(wrongActor.status).toBe(403);
    await wrongActor.body?.cancel();

    const redeemBody = {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
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
