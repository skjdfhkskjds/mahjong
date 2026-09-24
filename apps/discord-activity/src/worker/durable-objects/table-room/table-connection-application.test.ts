import { describe, expect, it } from "vitest";
import {
  HONG_KONG_V1_RANDOM_BYTES,
  startHongKongV1Game,
} from "@mahjong/rules-hong-kong";

import {
  activateTableConnection,
  closeTableConnection,
  reconcileTableWork,
  type ConnectionCommit,
  type ConnectionGrant,
  type TableConnectionStore,
} from "./table-connection-application.js";
import type { ControllerSnapshot } from "./table-controller-application.js";
import type { PresenceState } from "./table-presence-application.js";
import { botWorkTarget } from "./table-bot-policy.js";

class MemoryConnectionStore implements TableConnectionStore {
  public state: PresenceState = {
    tableExists: true,
    seatedActorIds: [],
    automation: [],
    lifecycle: { abandoned: false, roomActivityGeneration: 1 },
    deadlines: [],
  };
  public controllers: ControllerSnapshot = { controls: [], jobs: [] };
  public readonly commits: ConnectionCommit[] = [];
  public presenceState() {
    return this.state;
  }
  public controllerSnapshot() {
    return this.controllers;
  }
  public commitConnection(change: ConnectionCommit) {
    this.commits.push(change);
  }
}

function fixture() {
  const store = new MemoryConnectionStore();
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
  if (player === undefined) throw new Error("Missing current player");
  const actorId = player.actorId;
  const target = botWorkTarget(game, actorId);
  if (target === undefined) throw new Error("Missing controller target");
  store.state = {
    ...store.state,
    seatedActorIds: [actorId],
    automation: [{ actorId, autopilot: true, connectionGeneration: 3 }],
  };
  store.controllers = {
    controls: [{ actorId, kind: "HUMAN", controller: "BOT", generation: 3 }],
    jobs: [
      {
        actorId,
        target,
        controllerGeneration: 3,
        commandId: "preserved-command",
        dueAt: 500,
      },
    ],
  };
  const grant: ConnectionGrant = {
    actorId,
    displayName: "Player",
    tableId: "table",
    instanceId: "instance",
    bindingGeneration: 1,
    bindingProof: "P".repeat(43),
    sessionGeneration: 1,
    expiresAt: 1000,
  };
  return { store, game, actorId, grant };
}

describe("connection controller operations", () => {
  it("restores HUMAN and cancels substitute work in the grant commit before publication", () => {
    const { store, game, actorId, grant } = fixture();
    expect(
      activateTableConnection(store, grant, "connection", {
        now: 100,
        game,
        createCommandId: () => {
          throw new Error("Restoration must not mint work");
        },
      }),
    ).toBe(true);
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0]).toMatchObject({
      kind: "connect",
      connectionGeneration: "connection",
      presence: {
        automation: [
          {
            type: "upsert",
            automation: { actorId, autopilot: false, connectionGeneration: 4 },
          },
        ],
      },
      botWork: { cancelActorIds: [actorId], upsert: [] },
      publicTransition: true,
    });
  });

  it("preserves unchanged controller job identity and due time during repair without renewing turn deadlines", () => {
    const { store, game } = fixture();
    reconcileTableWork(store, {
      now: 300,
      game,
      observations: [],
      refreshGameDeadlines: false,
      createCommandId: () => {
        throw new Error("Unchanged work must retain identity");
      },
    });
    expect(store.commits[0]).toMatchObject({
      kind: "reconcile",
      gameDeadlines: undefined,
      botWork: { cancelActorIds: [], upsert: [] },
    });
  });

  it("keeps transient close grace and cancels work when the room is abandoned", () => {
    const { store, game, actorId } = fixture();
    store.state = {
      ...store.state,
      lifecycle: { abandoned: true, roomActivityGeneration: 1 },
    };
    closeTableConnection(store, "closing", {
      now: 100,
      game,
      observations: [],
      createCommandId: () => {
        throw new Error("Abandoned room cannot queue work");
      },
    });
    expect(store.commits[0]).toMatchObject({
      kind: "disconnect",
      connectionGeneration: "closing",
      botWork: { cancelActorIds: [actorId], upsert: [] },
    });
    expect(store.commits[0]?.presence.automation).toEqual([]);
  });
});
