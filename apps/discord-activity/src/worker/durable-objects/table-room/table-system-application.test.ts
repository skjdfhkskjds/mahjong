import { describe, expect, it } from "vitest";
import { startHongKongV1Game } from "@mahjong/rules-hong-kong";
import type { ControllerSnapshot } from "./table-controller-application.js";
import { prepareGameEventBatch } from "./table-game-events.js";
import { tableGameDeadline } from "./table-room-game-engine.js";

import {
  processTableDeadline as processDeadline,
  type PreparedSystemOperation,
  type TableSystemStore,
} from "./table-system-application.js";
import type {
  DeadlineCompletionState,
  PersistedDeadline,
  SystemCommandReceipt,
} from "./table-deadline-application.js";
import type { VerifiedStoredGame } from "./table-game-events.js";
import type {
  PresenceState,
  PresenceObservation,
} from "./table-presence-application.js";

const disconnect: PersistedDeadline = {
  deadlineId: "disconnect:3",
  dueAt: 100,
  kind: "disconnect",
  payload: {
    type: "system/disconnect-grace-expired",
    actorId: "player",
    connectionGeneration: 3,
  },
  processedAt: null,
  status: "pending",
  targetGeneration: 3,
};

class MemorySystemStore implements TableSystemStore {
  public deadline: PersistedDeadline = disconnect;
  public receipt: SystemCommandReceipt | undefined;
  public readonly commits: PreparedSystemOperation[] = [];
  public verifiedReads = 0;
  public game: VerifiedStoredGame | undefined;
  public desiredBotActorIds = new Set(["player"]);
  public controller: ControllerSnapshot = {
    controls: [
      { actorId: "player", kind: "HUMAN", controller: "HUMAN", generation: 3 },
    ],
    jobs: [],
  };
  public controllerSnapshot(): ControllerSnapshot {
    return this.controller;
  }
  public presence: PresenceState = {
    tableExists: true,
    seatedActorIds: ["player"],
    automation: [
      { actorId: "player", autopilot: false, connectionGeneration: 3 },
    ],
    lifecycle: { abandoned: false, roomActivityGeneration: 1 },
    deadlines: [disconnect],
  };
  public deadlineCompletion(): DeadlineCompletionState {
    return { deadline: this.deadline, receipt: this.receipt };
  }
  public presenceState() {
    return this.presence;
  }
  public verifiedGame(): Promise<VerifiedStoredGame | undefined> {
    this.verifiedReads += 1;
    return Promise.resolve(this.game);
  }
  public commitSystem(change: PreparedSystemOperation): void {
    this.commits.push(change);
    this.receipt = change.completion.receipt;
    this.deadline = {
      ...change.completion.deadline,
      status:
        change.completion.deadline.status === "cancelled"
          ? "cancelled"
          : "processed",
      processedAt:
        change.completion.deadline.status === "cancelled" ? null : change.now,
    };
  }
}

function processTableDeadline(
  store: MemorySystemStore,
  deadlineId: string,
  now: number,
  observations: readonly PresenceObservation[],
) {
  return processDeadline(store, deadlineId, now, observations, {
    desiredBotActorIds: store.desiredBotActorIds,
    createCommandId: () => "queued-command",
  });
}

describe("system operation application with a test store", () => {
  it("completes disconnect and its public transition atomically, then replays without a new game read or commit", async () => {
    const store = new MemorySystemStore();
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 100, []),
    ).toBe(true);
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0]).toMatchObject({
      presence: {
        automation: [
          {
            type: "upsert",
            automation: {
              actorId: "player",
              autopilot: true,
              connectionGeneration: 4,
            },
          },
        ],
      },
      publicTransition: true,
      abandonRoom: false,
      completion: {
        receipt: { result: { outcome: "processed", publicTransition: true } },
      },
    });
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 200, []),
    ).toBe(false);
    expect(store.commits).toHaveLength(1);
    expect(store.verifiedReads).toBe(1);
  });

  it("records a stale disconnect target without activating autopilot or publishing", async () => {
    const store = new MemorySystemStore();
    store.presence = {
      ...store.presence,
      automation: [
        { actorId: "player", autopilot: false, connectionGeneration: 4 },
      ],
    };
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 100, []),
    ).toBe(false);
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0]).toMatchObject({
      abandonRoom: false,
      publicTransition: false,
      game: undefined,
      gameDeadlines: undefined,
      completion: {
        receipt: { result: { outcome: "no-op", reason: "stale-target" } },
      },
    });
  });

  it("treats a current live connection as stale queued disconnect work", async () => {
    const store = new MemorySystemStore();
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 100, [
        { actorId: "player", expiresAt: 101 },
      ]),
    ).toBe(false);
    expect(store.commits[0]?.presence).toBeUndefined();
    expect(store.receipt?.result).toEqual({
      outcome: "no-op",
      reason: "stale-target",
    });
  });

  it("does not treat an exactly expired connection as current presence", async () => {
    const store = new MemorySystemStore();
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 100, [
        { actorId: "player", expiresAt: 100 },
      ]),
    ).toBe(true);
    expect(store.commits[0]?.presence?.automation).toEqual([
      {
        type: "upsert",
        automation: {
          actorId: "player",
          autopilot: true,
          connectionGeneration: 4,
        },
      },
    ]);
  });

  it("receipts cancelled work without reading game state or publishing", async () => {
    const store = new MemorySystemStore();
    store.deadline = { ...disconnect, status: "cancelled" };
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 100, []),
    ).toBe(false);
    expect(store.verifiedReads).toBe(0);
    expect(store.receipt?.result).toEqual({
      outcome: "no-op",
      reason: "cancelled",
    });
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 101, []),
    ).toBe(false);
    expect(store.commits).toHaveLength(1);
  });

  it("rejects early delivery before any authority write", async () => {
    const store = new MemorySystemStore();
    await expect(
      processTableDeadline(store, disconnect.deadlineId, 99, []),
    ).rejects.toThrow("before its deadline");
    expect(store.commits).toHaveLength(0);
    expect(store.verifiedReads).toBe(0);
  });

  it("abandons only the current inactive room generation", async () => {
    const store = new MemorySystemStore();
    store.deadline = {
      deadlineId: "abandonment:1",
      dueAt: 100,
      kind: "abandonment",
      payload: {
        type: "system/table-abandonment-expired",
        roomActivityGeneration: 1,
      },
      processedAt: null,
      status: "pending",
      targetGeneration: 1,
    };
    expect(
      await processTableDeadline(store, store.deadline.deadlineId, 100, []),
    ).toBe(true);
    expect(store.commits[0]).toMatchObject({
      abandonRoom: true,
      publicTransition: true,
    });
    const stale = new MemorySystemStore();
    stale.deadline = {
      ...store.deadline,
      status: "pending",
      processedAt: null,
    };
    stale.presence = {
      ...stale.presence,
      lifecycle: { abandoned: false, roomActivityGeneration: 2 },
    };
    expect(
      await processTableDeadline(stale, stale.deadline.deadlineId, 100, []),
    ).toBe(false);
    expect(stale.commits[0]).toMatchObject({
      abandonRoom: false,
      publicTransition: false,
    });
  });
  it("requires fresh controller health to request BOT before grace can hand off", async () => {
    const store = new MemorySystemStore();
    store.desiredBotActorIds.clear();
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 100, []),
    ).toBe(false);
    expect(store.commits[0]?.presence).toBeUndefined();
    expect(store.commits[0]?.botWork).toBeUndefined();
    expect(store.receipt?.result).toEqual({
      outcome: "no-op",
      reason: "stale-target",
    });
  });

  it("hands off grace at a new controller generation and queues work without changing game state", async () => {
    const store = new MemorySystemStore();
    const started = startHongKongV1Game(
      { east: "east", south: "south", west: "west", north: "north" },
      Uint8Array.from(
        { length: 1_028 },
        (_, index) => (index * 41 + 17) & 0xff,
      ),
    );
    const prepared = await prepareGameEventBatch(undefined, [started.event]);
    const target = tableGameDeadline(started.state);
    if (target?.kind !== "turn") throw new Error("Expected turn target.");
    const actorId = target.actorId;
    store.game = {
      state: started.state,
      events: [started.event],
      lastEventHash: prepared.lastEventHash,
    };
    store.controller = {
      controls: [
        { actorId, kind: "HUMAN", controller: "HUMAN", generation: 3 },
      ],
      jobs: [],
    };
    store.desiredBotActorIds = new Set([actorId]);
    store.deadline = {
      ...disconnect,
      payload: {
        type: "system/disconnect-grace-expired",
        actorId,
        connectionGeneration: 3,
      },
    };
    const turn = {
      ...target,
      dueAt: 60_000,
      processedAt: null,
      status: "pending" as const,
    };
    store.presence = {
      ...store.presence,
      seatedActorIds: [actorId],
      automation: [{ actorId, autopilot: false, connectionGeneration: 3 }],
      deadlines: [store.deadline, turn],
    };
    expect(
      await processTableDeadline(store, disconnect.deadlineId, 100, []),
    ).toBe(true);
    expect(store.commits[0]?.game).toBeUndefined();
    expect(store.commits[0]?.presence?.automation).toEqual([
      {
        type: "upsert",
        automation: { actorId, autopilot: true, connectionGeneration: 4 },
      },
    ]);
    expect(store.commits[0]?.gameDeadlines).toEqual({
      cancel: [target.deadlineId],
      schedule: [],
    });
    expect(store.commits[0]?.botWork).toMatchObject({
      cancelActorIds: [],
      upsert: [
        {
          actorId,
          controllerGeneration: 4,
          dueAt: 850,
          commandId: "queued-command",
        },
      ],
    });
  });
});
