import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ActivityInstance } from "../../src/worker/durable-objects/activity-instance.js";

interface IssuedSession {
  readonly access: "member" | "join-required";
  readonly binding: {
    readonly bindingGeneration: number;
    readonly bindingProof: string;
    readonly state: "bound";
    readonly tableId: string;
    readonly version: 1;
  };
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly version: 1;
}

const owner = { displayName: "Table Owner", id: "mock:owner" } as const;
const member = { displayName: "Invited Member", id: "mock:member" } as const;

function namespace(): DurableObjectNamespace<ActivityInstance> {
  return (
    env as unknown as {
      ACTIVITY_INSTANCE: DurableObjectNamespace<ActivityInstance>;
    }
  ).ACTIVITY_INSTANCE;
}

function instanceStub(instanceId = `instance-${crypto.randomUUID()}`) {
  return { instanceId, stub: namespace().getByName(instanceId) };
}

async function post(
  stub: DurableObjectStub<ActivityInstance>,
  path: string,
  body: object,
): Promise<Response> {
  return stub.fetch(`https://activity-instance.internal${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function issue(
  stub: DurableObjectStub<ActivityInstance>,
  instanceId: string,
  actor: typeof owner | typeof member,
  resumeCapability?: string,
): Promise<IssuedSession> {
  const response = await post(stub, "/internal/sessions/issue", {
    actor,
    expiresAt: Date.now() + 60_000,
    instanceId,
    ...(resumeCapability ? { resumeCapability } : {}),
  });
  expect(response.status).toBe(201);
  return response.json<IssuedSession>();
}

function credential(
  instanceId: string,
  actorId: string,
  session: IssuedSession,
): object {
  return {
    actorId,
    instanceId,
    sessionGeneration: session.sessionGeneration,
    sessionId: session.sessionId,
  };
}

describe("ActivityInstance coordination", () => {
  it("persists one binding and replaces duplicate actor sessions across eviction", async () => {
    const { instanceId, stub } = instanceStub();
    const first = await issue(stub, instanceId, owner);
    expect(first.access).toBe("member");
    expect(first.binding.tableId).toMatch(/^[A-Za-z0-9_-]{22}$/u);

    await evictDurableObject(stub);
    const replacement = await issue(stub, instanceId, owner);
    expect(replacement.binding).toEqual(first.binding);
    expect(replacement.sessionGeneration).toBe(first.sessionGeneration + 1);

    const oldValidation = await post(
      stub,
      "/internal/sessions/validate",
      credential(instanceId, owner.id, first),
    );
    expect(oldValidation.status).toBe(401);
    const currentValidation = await post(
      stub,
      "/internal/sessions/validate",
      credential(instanceId, owner.id, replacement),
    );
    expect(currentValidation.status).toBe(200);
  });

  it("keeps instance discovery separate from actor-bound table membership", async () => {
    const { instanceId, stub } = instanceStub();
    const ownerSession = await issue(stub, instanceId, owner);
    const candidateSession = await issue(stub, instanceId, member);
    expect(candidateSession.binding).toEqual(ownerSession.binding);
    expect(candidateSession.access).toBe("join-required");

    const invitationResponse = await post(
      stub,
      "/internal/invitations/create",
      {
        ...credential(instanceId, owner.id, ownerSession),
        invitedActorId: member.id,
      },
    );
    expect(invitationResponse.status).toBe(200);
    const invitation = await invitationResponse.json<{
      readonly capability: string;
    }>();

    const redeemed = await post(stub, "/internal/invitations/redeem", {
      ...credential(instanceId, member.id, candidateSession),
      actor: member,
      capability: invitation.capability,
    });
    expect(redeemed.status).toBe(200);

    const joinedSession = await issue(stub, instanceId, member);
    expect(joinedSession.access).toBe("member");
    const replay = await post(stub, "/internal/invitations/redeem", {
      ...credential(instanceId, member.id, joinedSession),
      actor: member,
      capability: invitation.capability,
    });
    expect(replay.status).toBe(410);
  });

  it("rebinds only through an owner resume capability and supersedes the old instance", async () => {
    const original = instanceStub();
    const originalSession = await issue(
      original.stub,
      original.instanceId,
      owner,
    );
    const capabilityResponse = await post(
      original.stub,
      "/internal/resume-capabilities/create",
      credential(original.instanceId, owner.id, originalSession),
    );
    expect(capabilityResponse.status).toBe(200);
    const { capability } = await capabilityResponse.json<{
      readonly capability: string;
    }>();

    const resumed = instanceStub();
    const resumedSession = await issue(
      resumed.stub,
      resumed.instanceId,
      owner,
      capability,
    );
    expect(resumedSession.binding.tableId).toBe(
      originalSession.binding.tableId,
    );
    expect(resumedSession.binding.bindingGeneration).toBe(
      originalSession.binding.bindingGeneration + 1,
    );

    const stale = await post(
      original.stub,
      "/internal/sessions/validate",
      credential(original.instanceId, owner.id, originalSession),
    );
    expect(stale.status).toBe(409);

    const repaired = await issue(original.stub, original.instanceId, owner);
    expect(repaired.binding.tableId).not.toBe(originalSession.binding.tableId);
  });
});
