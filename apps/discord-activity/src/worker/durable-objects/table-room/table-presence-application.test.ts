import { describe, expect, it } from "vitest";

import type { PersistedDeadline } from "./table-deadline-application.js";
import {
  preparePresenceReconciliation,
  prepareValidConnection,
  type PresenceState,
} from "./table-presence-application.js";

const state: PresenceState = {
  tableExists: true,
  seatedActorIds: ["actor:east", "actor:south"],
  automation: [
    { actorId: "actor:east", autopilot: false, connectionGeneration: 3 },
    { actorId: "actor:south", autopilot: false, connectionGeneration: 4 },
  ],
  lifecycle: { abandoned: false, roomActivityGeneration: 2 },
  deadlines: [],
};

function disconnectDeadline(
  deadlineId: string,
  dueAt: number,
  status: "cancelled" | "pending" = "pending",
): PersistedDeadline {
  return {
    deadlineId,
    dueAt,
    kind: "disconnect",
    payload: {
      type: "system/disconnect-grace-expired",
      actorId: "actor:east",
      connectionGeneration: 3,
    },
    processedAt: null,
    status,
    targetGeneration: 3,
  };
}

describe("table presence application", () => {
  it("uses the latest valid grant for grace and any actor for abandonment", () => {
    const changes = preparePresenceReconciliation(state, {
      now: 1_000,
      observations: [
        { actorId: "actor:east", expiresAt: 2_000 },
        { actorId: "actor:east", expiresAt: 3_000 },
        { actorId: "spectator", expiresAt: 5_000 },
      ],
    });
    expect(
      changes.deadlineSchedules.map(({ deadlineId, dueAt }) => ({
        deadlineId,
        dueAt,
      })),
    ).toEqual([
      { deadlineId: "disconnect-expiry:3", dueAt: 18_000 },
      { deadlineId: "disconnect:4", dueAt: 16_000 },
      { deadlineId: "abandonment-expiry:2", dueAt: 905_000 },
    ]);
    expect(changes.automation).toEqual([]);
  });

  it("preserves earlier grace after eviction and cancels duplicate pending work", () => {
    const changes = preparePresenceReconciliation(
      {
        ...state,
        deadlines: [
          disconnectDeadline("disconnect-expiry:3", 16_000),
          disconnectDeadline("disconnect:3", 19_000),
        ],
      },
      { now: 5_000, observations: [] },
    );
    expect(changes.deadlineReschedules).toEqual([
      { deadlineId: "disconnect-expiry:3", dueAt: 16_000 },
    ]);
    expect(changes.deadlineCancellations).toEqual(["disconnect:3"]);
    expect(
      changes.deadlineSchedules.some(
        ({ targetGeneration, kind }) =>
          targetGeneration === 3 && kind === "disconnect",
      ),
    ).toBe(false);
  });

  it("allocates replacement IDs without reusing consumed work", () => {
    const changes = preparePresenceReconciliation(
      {
        ...state,
        deadlines: [
          disconnectDeadline("disconnect:3", 16_000, "cancelled"),
          disconnectDeadline("disconnect:3:r16000", 16_000, "cancelled"),
        ],
      },
      { now: 1_000, observations: [] },
    );
    expect(changes.deadlineSchedules[0]?.deadlineId).toBe(
      "disconnect:3:r16000:1",
    );
    expect(changes.deadlineCancellations).toEqual([]);
  });

  it("retires unseated automation and reconstructs missing seated actors", () => {
    const changes = preparePresenceReconciliation(
      {
        ...state,
        seatedActorIds: ["actor:south", "actor:west"],
        deadlines: [disconnectDeadline("disconnect:3", 16_000)],
      },
      { now: 1_000, observations: [] },
    );
    expect(changes.automation).toEqual([
      { type: "delete", actorId: "actor:east" },
      {
        type: "upsert",
        automation: {
          actorId: "actor:west",
          autopilot: false,
          connectionGeneration: 5,
        },
      },
    ]);
    expect(changes.deadlineCancellations).toEqual(["disconnect:3"]);
    expect(
      changes.deadlineSchedules.find(
        ({ deadlineId }) => deadlineId === "disconnect:5",
      )?.payload,
    ).toEqual({
      type: "system/disconnect-grace-expired",
      actorId: "actor:west",
      connectionGeneration: 5,
    });
  });

  it("does not schedule autopilot grace or extend an abandoned room", () => {
    const changes = preparePresenceReconciliation(
      {
        ...state,
        lifecycle: { ...state.lifecycle, abandoned: true },
        automation: state.automation.map((entry) => ({
          ...entry,
          autopilot: true,
        })),
      },
      { now: 1_000, observations: [] },
    );
    expect(changes.deadlineSchedules).toEqual([]);
    expect(changes.automation).toEqual([]);
    expect(
      preparePresenceReconciliation(
        { ...state, tableExists: false },
        { now: 1_000, observations: [] },
      ).deadlineSchedules,
    ).toEqual([]);
  });

  it("requires a seated reconnect to recover abandonment and autopilot", () => {
    const abandoned = {
      ...state,
      lifecycle: { ...state.lifecycle, abandoned: true },
      automation: state.automation.map((entry) => ({
        ...entry,
        autopilot: true,
      })),
    };
    const spectator = prepareValidConnection(abandoned, "spectator", 1_000);
    expect(spectator.publicTransition).toBe(false);
    expect(spectator.changes.automation).toEqual([]);
    expect(spectator.changes.lifecycle).toEqual({
      abandoned: true,
      roomActivityGeneration: 3,
    });
    const player = prepareValidConnection(abandoned, "actor:east", 1_000);
    expect(player.publicTransition).toBe(true);
    expect(player.changes.automation).toEqual([
      {
        type: "upsert",
        automation: {
          actorId: "actor:east",
          autopilot: false,
          connectionGeneration: 5,
        },
      },
    ]);
    expect(player.changes.lifecycle).toEqual({
      abandoned: false,
      roomActivityGeneration: 3,
    });
    expect(player.seated).toBe(true);
    expect(
      prepareValidConnection(state, "actor:east", 1_000).publicTransition,
    ).toBe(false);
  });
});
