import {
  startHongKongV1Game,
  HONG_KONG_V1_RANDOM_BYTES,
} from "@mahjong/rules-hong-kong";
import {
  controlsAfterPresence,
  type ControllerSnapshot,
} from "./table-controller-application.js";
import type { PresenceState } from "./table-presence-application.js";
import { describe, expect, it } from "vitest";
import { connectionAuthorityIsCurrent } from "./table-connection-application.js";

import {
  activateAccessSession as activateSessionOperation,
  type AccessSessionRequest,
  applyAccessBinding,
  issueAccessCapability,
  redeemAccessInvitation,
  type AccessCapability,
  type AccessCommit,
  type AccessCommitOutcome,
  type AccessReceipt,
  type AccessTable,
  type PreparedBindingRequest,
  type TableAccessStore,
} from "./table-access-application.js";

class MemoryAccessStore implements TableAccessStore {
  public currentTable: AccessTable | undefined;
  public snapshot: ControllerSnapshot = { controls: [], jobs: [] };
  public presence: PresenceState = {
    tableExists: true,
    seatedActorIds: [],
    automation: [],
    lifecycle: { abandoned: false, roomActivityGeneration: 0 },
    deadlines: [],
  };
  public controllerSnapshot() {
    return this.snapshot;
  }
  public presenceState() {
    return this.presence;
  }
  public readonly receipts = new Map<string, AccessReceipt>();
  public readonly capabilities = new Map<string, AccessCapability>();
  public readonly sessions = new Map<string, number>();
  public readonly members = new Map<string, "owner" | "member">();
  public publicVersion = 0;
  public readonly commits: AccessCommit[] = [];

  public table() {
    return this.currentTable;
  }
  public receipt(id: string) {
    return this.receipts.get(id);
  }
  public capability(id: string) {
    return this.capabilities.get(id);
  }
  public sessionGeneration(id: string) {
    return this.sessions.get(id);
  }
  public memberRole(id: string) {
    return this.members.get(id);
  }
  public commit(change: AccessCommit): AccessCommitOutcome {
    this.commits.push(change);
    switch (change.kind) {
      case "admit-binding":
        if (this.receipts.has(change.operationId)) return { kind: "conflict" };
        this.receipts.set(change.operationId, {
          requestJson: change.requestJson,
          status: "pending",
          result: undefined,
        });
        break;
      case "complete-binding": {
        const receipt = this.receipts.get(change.operationId);
        if (receipt === undefined) throw new Error("Missing admitted receipt");
        this.receipts.set(change.operationId, {
          ...receipt,
          status: change.status,
          result: change.result,
        });
        if (change.change.kind !== "none")
          this.currentTable = change.change.table;
        if (change.change.kind === "create")
          this.members.set(change.change.actor.id, "owner");
        if (change.change.kind === "resume") {
          const capability = this.capabilities.get(change.change.capabilityId);
          if (capability === undefined) throw new Error("Missing capability");
          this.capabilities.set(change.change.capabilityId, {
            ...capability,
            consumedActorId: change.change.table.ownerActorId,
            consumedOperationId: change.operationId,
          });
          this.sessions.clear();
        }
        break;
      }
      case "issue-capability":
        this.capabilities.set(change.capabilityId, change.capability);
        break;
      case "redeem-invitation": {
        const capability = this.capabilities.get(change.capabilityId);
        if (capability === undefined) throw new Error("Missing capability");
        this.capabilities.set(change.capabilityId, {
          ...capability,
          consumedActorId: change.actor.id,
        });
        if (change.addMember) {
          this.members.set(change.actor.id, "member");
          this.publicVersion += 1;
        }
        break;
      }
      case "activate-session":
        this.sessions.set(change.actorId, change.sessionGeneration);
        if (change.presence !== undefined)
          this.snapshot = {
            ...this.snapshot,
            controls: controlsAfterPresence(
              this.snapshot.controls,
              change.presence,
            ),
          };
        if (change.botWork !== undefined) {
          const work = change.botWork;
          this.snapshot = {
            ...this.snapshot,
            jobs: [
              ...this.snapshot.jobs.filter(
                ({ actorId }) =>
                  !work.cancelActorIds.includes(actorId) &&
                  !work.upsert.some((job) => job.actorId === actorId),
              ),
              ...work.upsert,
            ],
          };
        }
        if (change.publicTransition) this.publicVersion += 1;
        break;
    }
    return { kind: "committed" };
  }
}

function activateAccessSession(
  store: MemoryAccessStore,
  request: AccessSessionRequest,
  now: number,
) {
  return activateSessionOperation(store, request, {
    now,
    observations: [],
    game: undefined,
    createCommandId: () => "unused",
  });
}

const owner = { id: "owner", displayName: "Owner" };
const create: PreparedBindingRequest = {
  actor: owner,
  deadlineAt: 500,
  instanceId: "instance",
  intent: { kind: "create" },
  operationId: "create",
};
const authorization = {
  instanceId: "instance",
  bindingGeneration: 1,
  bindingProof: "proof",
};
function createdStore() {
  const store = new MemoryAccessStore();
  applyAccessBinding(store, create, {
    tableId: "table",
    now: 100,
    bindingProof: "proof",
  });
  activateAccessSession(
    store,
    { ...authorization, actorId: "owner", sessionGeneration: 1 },
    100,
  );
  return store;
}
function issue(
  store: MemoryAccessStore,
  kind: "resume" | "invitation",
  capabilityId = "cap",
) {
  return issueAccessCapability(
    store,
    {
      ...authorization,
      actorId: "owner",
      sessionGeneration: 1,
      invitedActorId: "invitee",
    },
    {
      kind,
      capabilityId,
      secret: "secret",
      secretHash: "digest",
      now: 100,
    },
  );
}

describe("table access application without runtime storage", () => {
  it("replays completed bindings after expiry and rejects operation collisions", () => {
    const store = createdStore();
    const count = store.commits.length;
    const replay = applyAccessBinding(store, create, {
      tableId: "table",
      now: 1_000,
      bindingProof: "replacement",
    });
    expect(replay).toEqual({
      status: 200,
      body: {
        version: 1,
        tableId: "table",
        bindingGeneration: 1,
        bindingProof: "proof",
        role: "owner",
      },
    });
    expect(store.commits).toHaveLength(count);
    expect(
      applyAccessBinding(
        store,
        { ...create, actor: { id: "other", displayName: "Other" } },
        { tableId: "table", now: 100, bindingProof: "other" },
      ).status,
    ).toBe(409);
  });

  it("recovers a historical pending receipt after the binding committed and deadline elapsed", () => {
    const store = createdStore();
    const receipt = store.receipts.get("create");
    if (receipt === undefined) throw new Error("Missing receipt");
    store.receipts.set("create", {
      ...receipt,
      status: "pending",
      result: undefined,
    });
    expect(
      applyAccessBinding(store, create, {
        tableId: "table",
        now: 1_000,
        bindingProof: "unused",
      }).status,
    ).toBe(200);
    expect(store.table()?.bindingProof).toBe("proof");
    expect(store.receipt("create")?.status).toBe("applied");
  });

  it("rejects expired new and pending uncommitted operations without creating a table", () => {
    const store = new MemoryAccessStore();
    expect(
      applyAccessBinding(store, create, {
        tableId: "table",
        now: 500,
        bindingProof: "proof",
      }).status,
    ).toBe(410);
    expect(store.commits).toHaveLength(0);
    store.receipts.set("create", {
      requestJson: JSON.stringify({
        actor: owner,
        deadlineAt: 500,
        instanceId: "instance",
        intent: { kind: "create" },
        operationId: "create",
        version: 1,
      }),
      status: "pending",
      result: undefined,
    });
    expect(
      applyAccessBinding(store, create, {
        tableId: "table",
        now: 500,
        bindingProof: "proof",
      }).status,
    ).toBe(410);
    expect(store.receipt("create")?.status).toBe("rejected");
    expect(store.table()).toBeUndefined();
  });

  it("resumes with one atomic receipt/binding/capability change and clears sessions", () => {
    const store = createdStore();
    issue(store, "resume");
    const request: PreparedBindingRequest = {
      ...create,
      instanceId: "next",
      operationId: "resume",
      intent: {
        kind: "resume",
        capabilityId: "cap",
        capabilitySecretHash: "digest",
        tableId: "table",
      },
    };
    expect(
      applyAccessBinding(store, request, {
        tableId: "table",
        now: 200,
        bindingProof: "next-proof",
      }).status,
    ).toBe(200);
    expect(store.table()).toMatchObject({
      bindingGeneration: 2,
      instanceId: "next",
    });
    expect(store.sessions.size).toBe(0);
    expect(store.capability("cap")?.consumedOperationId).toBe("resume");
    expect(store.receipt("resume")?.requestJson).not.toContain("secret");
    expect(store.commits.at(-1)).toMatchObject({
      kind: "complete-binding",
      change: { kind: "resume" },
      status: "applied",
    });
    expect(
      applyAccessBinding(store, request, {
        tableId: "table",
        now: 1_000_000,
        bindingProof: "unused",
      }).status,
    ).toBe(200);
  });

  it("matches the historical resume receipt encoding regardless of prepared property order", () => {
    const store = createdStore();
    issue(store, "resume");
    store.receipts.set("resume", {
      requestJson: JSON.stringify({
        actor: owner,
        deadlineAt: 500,
        instanceId: "next",
        intent: {
          kind: "resume",
          capabilityId: "cap",
          capabilitySecretHash: "digest",
          tableId: "table",
        },
        operationId: "resume",
        version: 1,
      }),
      status: "pending",
      result: undefined,
    });
    const request: PreparedBindingRequest = {
      ...create,
      instanceId: "next",
      operationId: "resume",
      intent: {
        tableId: "table",
        capabilitySecretHash: "digest",
        capabilityId: "cap",
        kind: "resume",
      },
    };
    expect(
      applyAccessBinding(store, request, {
        tableId: "table",
        now: 200,
        bindingProof: "next",
      }).status,
    ).toBe(200);
  });

  it("activates invitees before authorization and publishes only a newly admitted member", () => {
    const store = createdStore();
    issue(store, "invitation");
    const activation = activateAccessSession(
      store,
      { ...authorization, actorId: "invitee", sessionGeneration: 2 },
      200,
    );
    expect(activation.result.status).toBe(403);
    expect(activation.replaceActorSockets).toBe("invitee");
    expect(store.sessionGeneration("invitee")).toBe(2);
    const request = {
      ...authorization,
      actor: { id: "invitee", displayName: "Invitee" },
      sessionGeneration: 2,
      now: 200,
    };
    const input = {
      tableId: "table",
      capabilityId: "cap",
      secretHash: "digest",
      now: 200,
    };
    expect(redeemAccessInvitation(store, request, input)).toMatchObject({
      result: { status: 200 },
      publishSnapshots: true,
    });
    expect(store.publicVersion).toBe(1);
    expect(redeemAccessInvitation(store, request, input)).toMatchObject({
      result: { status: 410 },
      publishSnapshots: false,
    });
    issue(store, "invitation", "cap2");
    expect(
      redeemAccessInvitation(store, request, { ...input, capabilityId: "cap2" })
        .publishSnapshots,
    ).toBe(false);
    expect(store.publicVersion).toBe(1);
  });

  it("retains semantic session, capability subject, expiry, and generation checks", () => {
    const store = createdStore();
    issue(store, "invitation");
    activateAccessSession(
      store,
      { ...authorization, actorId: "invitee", sessionGeneration: 2 },
      200,
    );
    const request = {
      ...authorization,
      actor: { id: "invitee", displayName: "Invitee" },
      sessionGeneration: 2,
      now: 200,
    };
    const input = {
      tableId: "table",
      capabilityId: "cap",
      secretHash: "digest",
      now: 200,
    };
    const count = store.commits.length;
    expect(
      redeemAccessInvitation(store, { ...request, sessionGeneration: 1 }, input)
        .result.status,
    ).toBe(409);
    expect(
      redeemAccessInvitation(store, request, { ...input, secretHash: "wrong" })
        .result.status,
    ).toBe(403);
    expect(
      redeemAccessInvitation(store, request, { ...input, now: 900_100 }).result
        .status,
    ).toBe(410);
    const capability = store.capability("cap");
    if (capability === undefined) throw new Error("Missing capability");
    store.capabilities.set("cap", {
      ...capability,
      expectedBindingGeneration: 2,
    });
    expect(redeemAccessInvitation(store, request, input).result.status).toBe(
      409,
    );
    expect(store.commits).toHaveLength(count);
  });

  it("rejects stale activation without replacement and permits idempotent activation", () => {
    const store = createdStore();
    expect(
      activateAccessSession(
        store,
        { ...authorization, actorId: "owner", sessionGeneration: 2 },
        200,
      ).replaceActorSockets,
    ).toBe("owner");
    expect(
      activateAccessSession(
        store,
        { ...authorization, actorId: "owner", sessionGeneration: 1 },
        201,
      ),
    ).toMatchObject({
      result: { status: 409 },
      replaceActorSockets: undefined,
    });
    expect(
      activateAccessSession(
        store,
        { ...authorization, actorId: "owner", sessionGeneration: 2 },
        202,
      ),
    ).toMatchObject({
      result: { status: 200 },
      replaceActorSockets: undefined,
    });
    expect(store.sessionGeneration("owner")).toBe(2);
  });
  it("never grants a dedicated bot session or socket authority", () => {
    const store = createdStore();
    const actorId = "bot:00000000-0000-4000-8000-000000000001";
    store.members.set(actorId, "member");
    const count = store.commits.length;
    expect(
      activateAccessSession(
        store,
        { ...authorization, actorId, sessionGeneration: 1 },
        200,
      ),
    ).toMatchObject({
      result: { status: 403 },
      replaceActorSockets: undefined,
    });
    expect(store.commits).toHaveLength(count);
    // Even a legacy/corrupt restored session cannot authorize a bot socket.
    store.sessions.set(actorId, 1);
    expect(
      connectionAuthorityIsCurrent(store, {
        ...authorization,
        actorId,
        displayName: "Bot South",
        expiresAt: 300,
        sessionGeneration: 1,
        tableId: "table",
      }),
    ).toBe(false);
  });
});

describe("session departure controller coordination", () => {
  function fixture() {
    const store = createdStore();
    const game = startHongKongV1Game(
      { east: "owner", south: "south", west: "west", north: "north" },
      new Uint8Array(HONG_KONG_V1_RANDOM_BYTES),
    ).state;
    const player = [
      game.players.east,
      game.players.south,
      game.players.west,
      game.players.north,
    ].find(({ seat }) => seat === game.turn);
    if (player === undefined) throw new Error("Missing current player");
    const actorId = player.actorId;
    store.members.set(actorId, "member");
    store.sessions.set(actorId, 1);
    store.snapshot = {
      controls: [
        { actorId, kind: "HUMAN", controller: "HUMAN", generation: 3 },
      ],
      jobs: [],
    };
    store.presence = {
      ...store.presence,
      seatedActorIds: [actorId],
      automation: [{ actorId, autopilot: false, connectionGeneration: 3 }],
    };
    return {
      store,
      actorId,
      input: {
        now: 200,
        game,
        observations: [{ actorId, expiresAt: 1000 }],
        createCommandId: () => "logout-bot-command",
      },
    };
  }

  it("promotes logout and hands off after excluding replaced session sockets in one commit", () => {
    const { store, actorId, input } = fixture();
    const count = store.commits.length;
    const result = activateSessionOperation(
      store,
      { ...authorization, actorId, sessionGeneration: 2, departure: true },
      input,
    );
    expect(result).toMatchObject({
      departed: true,
      replaceActorSockets: actorId,
      result: { status: 200 },
    });
    expect(store.commits).toHaveLength(count + 1);
    expect(store.commits.at(-1)).toMatchObject({
      kind: "activate-session",
      sessionGeneration: 2,
      publicTransition: true,
      presence: {
        automation: [
          {
            type: "upsert",
            automation: { actorId, autopilot: true, connectionGeneration: 4 },
          },
        ],
      },
      botWork: {
        upsert: [
          {
            actorId,
            controllerGeneration: 4,
            commandId: "logout-bot-command",
            dueAt: 950,
          },
        ],
      },
    });
    expect(store.publicVersion).toBe(1);
    expect(
      activateSessionOperation(
        store,
        { ...authorization, actorId, sessionGeneration: 2, departure: true },
        { ...input, observations: [] },
      ).departed,
    ).toBe(false);
    expect(store.publicVersion).toBe(1);
  });

  it("does not hand off during ordinary replacement or while another same-generation socket is usable", () => {
    const replacement = fixture();
    expect(
      activateSessionOperation(
        replacement.store,
        {
          ...authorization,
          actorId: replacement.actorId,
          sessionGeneration: 2,
        },
        replacement.input,
      ).departed,
    ).toBe(false);
    expect(replacement.store.snapshot.controls[0]?.controller).toBe("HUMAN");
    const live = fixture();
    expect(
      activateSessionOperation(
        live.store,
        {
          ...authorization,
          actorId: live.actorId,
          sessionGeneration: 1,
          departure: true,
        },
        live.input,
      ).departed,
    ).toBe(false);
    expect(live.store.publicVersion).toBe(0);
    expect(live.store.snapshot.jobs).toEqual([]);
  });
});
