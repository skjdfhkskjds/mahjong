import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
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
  readonly role?: "member" | "owner";
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
  const response = await issueResponse(
    stub,
    instanceId,
    actor,
    resumeCapability,
  );
  expect(response.status).toBe(201);
  return response.json<IssuedSession>();
}

function issueResponse(
  stub: DurableObjectStub<ActivityInstance>,
  instanceId: string,
  actor: typeof owner | typeof member,
  resumeCapability?: string,
): Promise<Response> {
  return post(stub, "/internal/sessions/issue", {
    actor,
    expiresAt: Date.now() + 60_000,
    instanceId,
    ...(resumeCapability ? { resumeCapability } : {}),
  });
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
    expect(first.role).toBe("owner");
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

  it("converges concurrent initial binding requests on one table and owner", async () => {
    const { instanceId, stub } = instanceStub();
    const sessions = await Promise.all([
      issue(stub, instanceId, owner),
      issue(stub, instanceId, member),
    ]);

    expect(sessions[0].binding).toEqual(sessions[1].binding);
    expect(sessions.filter(({ access }) => access === "member")).toHaveLength(
      1,
    );
    expect(sessions.filter(({ role }) => role === "owner")).toHaveLength(1);
    expect(
      sessions.filter(({ access }) => access === "join-required"),
    ).toHaveLength(1);
  });

  it("stores only a digest while a resume binding is pending and retries with the request bearer", async () => {
    const { instanceId, stub } = instanceStub();
    const locator = "A".repeat(22);
    const secret = "B".repeat(43);
    const resumeCapability = `v1.${"C".repeat(22)}.${locator}.${secret}`;

    const inspected = await runInDurableObject(
      stub,
      async (instance, state) => {
        const activity = instance as unknown as {
          env: { TABLE_ROOM: DurableObjectNamespace };
        };
        const originalNamespace = activity.env.TABLE_ROOM;
        let pending: unknown;
        let bindingAttempts = 0;
        const appliedCapabilities: unknown[] = [];
        activity.env.TABLE_ROOM = {
          getByName: () =>
            ({
              fetch: async (request: Request | string, init?: RequestInit) => {
                const path = new URL(
                  typeof request === "string" ? request : request.url,
                ).pathname;
                if (path === "/internal/sessions/activate") {
                  return Response.json({
                    active: true,
                    role: "owner",
                    version: 1,
                  });
                }
                pending = await state.storage.get(
                  "activity-instance:binding:v1",
                );
                bindingAttempts += 1;
                appliedCapabilities.push(
                  (typeof init?.body === "string" &&
                    init.body.includes(resumeCapability)) ||
                    (request instanceof Request &&
                      (await request.clone().text()).includes(resumeCapability))
                    ? resumeCapability
                    : undefined,
                );
                return bindingAttempts === 1
                  ? Response.json(
                      {
                        error: {
                          code: "binding-unavailable",
                          message:
                            "The table binding is temporarily unavailable.",
                        },
                      },
                      { status: 503 },
                    )
                  : Response.json({
                      bindingGeneration: 2,
                      bindingProof: "D".repeat(43),
                      tableId: "C".repeat(22),
                      version: 1,
                    });
              },
            }) as DurableObjectStub,
        } as unknown as DurableObjectNamespace;
        const request = () =>
          new Request(
            "https://activity-instance.internal/internal/sessions/issue",
            {
              body: JSON.stringify({
                actor: owner,
                expiresAt: Date.now() + 60_000,
                instanceId,
                resumeCapability,
              }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            },
          );
        try {
          const first = await instance.fetch(request());
          const retry = await instance.fetch(request());
          return {
            appliedCapabilities,
            firstStatus: first.status,
            pending,
            retryStatus: retry.status,
          };
        } finally {
          activity.env.TABLE_ROOM = originalNamespace;
        }
      },
    );

    expect(inspected.firstStatus).toBe(503);
    expect(inspected.retryStatus).toBe(201);
    expect(inspected.appliedCapabilities).toEqual([
      resumeCapability,
      resumeCapability,
    ]);
    const serialized = JSON.stringify(inspected.pending);
    expect(serialized).not.toContain(resumeCapability);
    expect(serialized).not.toContain(secret);
    const stored = inspected.pending as {
      readonly intent: {
        readonly capabilityDigest: unknown;
        readonly kind: unknown;
      };
    };
    expect(stored.intent.kind).toBe("resume");
    expect(stored.intent.capabilityDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("keeps only the latest credential valid across concurrent session issuances", async () => {
    const { instanceId, stub } = instanceStub();
    const first = await issue(stub, instanceId, owner);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => issueResponse(stub, instanceId, owner)),
    );
    expect(
      responses.every(({ status }) => status === 201 || status === 409),
    ).toBe(true);
    const successfulResponses = responses.filter(
      ({ status }) => status === 201,
    );
    if (successfulResponses.length === 0) {
      throw new Error("A concurrent session issuance did not succeed.");
    }
    const successful = await Promise.all(
      successfulResponses.map((response) => response.json<IssuedSession>()),
    );
    const latest = successful.reduce((current, candidate) =>
      candidate.sessionGeneration > current.sessionGeneration
        ? candidate
        : current,
    );
    expect(latest.sessionGeneration).toBeGreaterThan(first.sessionGeneration);
    for (const response of responses.filter(({ status }) => status === 409)) {
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "session-replaced-concurrently" },
      });
    }

    const oldValidation = await post(
      stub,
      "/internal/sessions/validate",
      credential(instanceId, owner.id, first),
    );
    expect(oldValidation.status).toBe(401);
    for (const session of successful) {
      const validation = await post(
        stub,
        "/internal/sessions/validate",
        credential(instanceId, owner.id, session),
      );
      expect(validation.status).toBe(session === latest ? 200 : 401);
    }
  });

  it("keeps the current credential valid when replacement activation fails", async () => {
    const { instanceId, stub } = instanceStub();
    const current = await issue(stub, instanceId, owner);

    const failedStatus = await runInDurableObject(stub, async (instance) => {
      const activity = instance as unknown as {
        env: { TABLE_ROOM: DurableObjectNamespace };
      };
      const originalNamespace = activity.env.TABLE_ROOM;
      activity.env.TABLE_ROOM = {
        getByName: () =>
          ({
            fetch: () =>
              Promise.resolve(
                Response.json(
                  {
                    error: {
                      code: "table-unavailable",
                      message: "The table is temporarily unavailable.",
                    },
                  },
                  { status: 503 },
                ),
              ),
          }) as unknown as DurableObjectStub,
      } as unknown as DurableObjectNamespace;
      try {
        return (
          await instance.fetch(
            new Request(
              "https://activity-instance.internal/internal/sessions/issue",
              {
                body: JSON.stringify({
                  actor: owner,
                  expiresAt: Date.now() + 60_000,
                  instanceId,
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
              },
            ),
          )
        ).status;
      } finally {
        activity.env.TABLE_ROOM = originalNamespace;
      }
    });

    expect(failedStatus).toBe(503);
    const validation = await post(
      stub,
      "/internal/sessions/validate",
      credential(instanceId, owner.id, current),
    );
    expect(validation.status).toBe(200);
  });

  it("recovers the same proposed generation after a lost activation response", async () => {
    const { instanceId, stub } = instanceStub();
    const current = await issue(stub, instanceId, owner);

    const failedStatus = await runInDurableObject(stub, async (instance) => {
      const activity = instance as unknown as {
        env: { TABLE_ROOM: DurableObjectNamespace };
      };
      const originalNamespace = activity.env.TABLE_ROOM;
      activity.env.TABLE_ROOM = {
        getByName: (name: string) =>
          ({
            fetch: async (request: Request | string, init?: RequestInit) => {
              const applied = await originalNamespace
                .getByName(name)
                .fetch(request, init);
              await applied.body?.cancel();
              throw new Error("The activation response was lost.");
            },
          }) as unknown as DurableObjectStub,
      } as unknown as DurableObjectNamespace;
      try {
        return (
          await instance.fetch(
            new Request(
              "https://activity-instance.internal/internal/sessions/issue",
              {
                body: JSON.stringify({
                  actor: owner,
                  expiresAt: Date.now() + 60_000,
                  instanceId,
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
              },
            ),
          )
        ).status;
      } finally {
        activity.env.TABLE_ROOM = originalNamespace;
      }
    });

    expect(failedStatus).toBe(503);
    const recovered = await issue(stub, instanceId, owner);
    expect(recovered.sessionGeneration).toBe(current.sessionGeneration + 1);
    const validation = await post(
      stub,
      "/internal/sessions/validate",
      credential(instanceId, owner.id, recovered),
    );
    expect(validation.status).toBe(200);
  });

  it("does not let concurrent logout overwrite a replacement session", async () => {
    const { instanceId, stub } = instanceStub();
    const first = await issue(stub, instanceId, owner);

    const [revocation, replacementResponse] = await Promise.all([
      post(
        stub,
        "/internal/sessions/revoke",
        credential(instanceId, owner.id, first),
      ),
      issueResponse(stub, instanceId, owner),
    ]);
    expect([
      [204, 201],
      [204, 409],
      [401, 201],
    ]).toContainEqual([revocation.status, replacementResponse.status]);

    const oldValidation = await post(
      stub,
      "/internal/sessions/validate",
      credential(instanceId, owner.id, first),
    );
    expect(oldValidation.status).toBe(401);
    const replacement =
      replacementResponse.status === 201
        ? await replacementResponse.json<IssuedSession>()
        : await issue(stub, instanceId, owner);
    const replacementValidation = await post(
      stub,
      "/internal/sessions/validate",
      credential(instanceId, owner.id, replacement),
    );
    expect(replacementValidation.status).toBe(200);
  });

  it("revokes a valid join-required session before invitation redemption", async () => {
    const { instanceId, stub } = instanceStub();
    await issue(stub, instanceId, owner);
    const candidate = await issue(stub, instanceId, member);
    expect(candidate.access).toBe("join-required");

    const revocation = await post(
      stub,
      "/internal/sessions/revoke",
      credential(instanceId, member.id, candidate),
    );
    expect(revocation.status).toBe(204);

    const validation = await post(
      stub,
      "/internal/sessions/validate",
      credential(instanceId, member.id, candidate),
    );
    expect(validation.status).toBe(401);
  });

  it.each([
    "/internal/sessions/issue",
    "/internal/sessions/validate",
    "/internal/sessions/revoke",
    "/internal/invitations/create",
    "/internal/invitations/redeem",
    "/internal/resume-capabilities/create",
  ])("rejects a mismatched instance ID on %s", async (path) => {
    const { stub } = instanceStub();
    const response = await post(stub, path, {
      instanceId: "another-activity-instance",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "instance-id-mismatch" },
    });
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

    const mismatchedActor = await post(stub, "/internal/invitations/redeem", {
      ...credential(instanceId, owner.id, ownerSession),
      actor: member,
      capability: invitation.capability,
    });
    expect(mismatchedActor.status).toBe(400);
    await expect(mismatchedActor.json()).resolves.toMatchObject({
      error: { code: "invalid-invitation-request" },
    });

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

  it("recovers an unbound instance after a resume targets an unknown table", async () => {
    const { instanceId, stub } = instanceStub();
    const unknownTableId = "Z".repeat(22);
    const fakeCapability = `v1.${unknownTableId}.${"Y".repeat(22)}.${"X".repeat(43)}`;
    const rejected = await post(stub, "/internal/sessions/issue", {
      actor: owner,
      expiresAt: Date.now() + 60_000,
      instanceId,
      resumeCapability: fakeCapability,
    });
    expect(rejected.status).toBe(404);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "table-not-found" },
    });

    const created = await issue(stub, instanceId, owner);
    expect(created.access).toBe("member");
    expect(created.binding.tableId).not.toBe(unknownTableId);
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
