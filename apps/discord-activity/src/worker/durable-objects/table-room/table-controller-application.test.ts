import { describe, expect, it } from "vitest";
import {
  HONG_KONG_V1_RANDOM_BYTES,
  startHongKongV1Game,
} from "@mahjong/rules-hong-kong";
import {
  controlsAfterPresence,
  prepareControllerWork,
  preparePlayerSubstitution,
} from "./table-controller-application.js";
import type { PlayerControl } from "./table-player-control.js";
import type { PresenceChanges } from "./table-presence-application.js";
import { tableGameDeadline } from "./table-room-game-engine.js";

const game = startHongKongV1Game(
  { east: "east", south: "south", west: "west", north: "north" },
  new Uint8Array(HONG_KONG_V1_RANDOM_BYTES),
).state;
const controls: readonly PlayerControl[] = [
  "east",
  "south",
  "west",
  "north",
].map((actorId) => ({
  actorId,
  kind: "HUMAN",
  controller: "HUMAN",
  generation: 1,
}));
function handoff(autopilot: boolean, generation: number): PresenceChanges {
  return {
    automation: [
      {
        type: "upsert",
        automation: {
          actorId: "east",
          autopilot,
          connectionGeneration: generation,
        },
      },
    ],
    deadlineCancellations: [],
    deadlineReschedules: [],
    deadlineSchedules: [],
    updatedAt: 100,
  };
}
describe("controller work within prepared table operations", () => {
  it("increments human handoff generation and cancels its pending turn without running a move", () => {
    const target = tableGameDeadline(game);
    if (target?.kind !== "turn") throw new Error("Expected a turn target.");
    const control = controls.find((entry) => entry.actorId === target.actorId);
    const before = JSON.stringify(game);
    const change = preparePlayerSubstitution({
      control,
      game,
      now: 100,
      deadlines: [
        {
          deadlineId: target.deadlineId,
          kind: target.kind,
          payload: target.payload,
          targetGeneration: target.targetGeneration,
          dueAt: 500,
          status: "pending",
          processedAt: null,
        },
      ],
    });
    expect(change).toMatchObject({
      presence: {
        automation: [
          {
            type: "upsert",
            automation: {
              actorId: target.actorId,
              autopilot: true,
              connectionGeneration: 2,
            },
          },
        ],
      },
      gameDeadlines: { cancel: [target.deadlineId], schedule: [] },
    });
    expect(JSON.stringify(game)).toBe(before);
    expect(
      preparePlayerSubstitution({
        control: {
          actorId: target.actorId,
          kind: "BOT",
          controller: "BOT",
          generation: 0,
        },
        game,
        deadlines: [],
        now: 100,
      }),
    ).toBeUndefined();
    expect(
      preparePlayerSubstitution({
        control: {
          actorId: target.actorId,
          kind: "HUMAN",
          controller: "BOT",
          generation: 2,
        },
        game,
        deadlines: [],
        now: 100,
      }),
    ).toBeUndefined();
  });
  it("uses the prospective controller state without changing player identity or canonical game", () => {
    const original = JSON.stringify(game);
    const after = controlsAfterPresence(controls, handoff(true, 2));
    const prepared = prepareControllerWork({
      controls: after,
      jobs: [],
      game,
      now: 100,
      abandoned: false,
      createCommandId: () => "job-one",
    });
    expect(prepared.upsert).toEqual([
      {
        actorId: "east",
        target: `turn:${String(game.sequence)}`,
        commandId: "job-one",
        dueAt: 850,
        controllerGeneration: 2,
      },
    ]);
    expect(controls[0]?.controller).toBe("HUMAN");
    expect(JSON.stringify(game)).toBe(original);
  });
  it("retains pending job identity on unchanged state and cancels on human restoration", () => {
    const after = controlsAfterPresence(controls, handoff(true, 2));
    const first = prepareControllerWork({
      controls: after,
      jobs: [],
      game,
      now: 100,
      abandoned: false,
      createCommandId: () => "job-one",
    });
    expect(
      prepareControllerWork({
        controls: after,
        jobs: first.upsert,
        game,
        now: 500,
        abandoned: false,
        createCommandId: () => "unexpected",
      }),
    ).toEqual({ cancelActorIds: [], upsert: [] });
    const restored = controlsAfterPresence(after, handoff(false, 3));
    expect(
      prepareControllerWork({
        controls: restored,
        jobs: first.upsert,
        game,
        now: 501,
        abandoned: false,
        createCommandId: () => "unexpected",
      }),
    ).toEqual({ cancelActorIds: ["east"], upsert: [] });
  });
  it("cancels work on abandonment even when the game target remains legal", () => {
    const after = controlsAfterPresence(controls, handoff(true, 2));
    const jobs = prepareControllerWork({
      controls: after,
      jobs: [],
      game,
      now: 100,
      abandoned: false,
      createCommandId: () => "job-one",
    }).upsert;
    expect(
      prepareControllerWork({
        controls: after,
        jobs,
        game,
        now: 500,
        abandoned: true,
        createCommandId: () => "unexpected",
      }),
    ).toEqual({ cancelActorIds: ["east"], upsert: [] });
  });
  it("replaces work after another handoff even when canonical progress is unchanged", () => {
    const firstHandoff = controlsAfterPresence(controls, handoff(true, 2));
    const jobs = prepareControllerWork({
      controls: firstHandoff,
      jobs: [],
      game,
      now: 100,
      abandoned: false,
      createCommandId: () => "old-controller-command",
    }).upsert;
    const restored = controlsAfterPresence(firstHandoff, handoff(false, 3));
    const nextHandoff = controlsAfterPresence(restored, handoff(true, 4));
    const replacement = prepareControllerWork({
      controls: nextHandoff,
      jobs,
      game,
      now: 500,
      abandoned: false,
      createCommandId: () => "new-controller-command",
    });
    expect(replacement).toEqual({
      cancelActorIds: [],
      upsert: [
        {
          actorId: "east",
          target: jobs[0]?.target,
          commandId: "new-controller-command",
          dueAt: 1_250,
          controllerGeneration: 4,
        },
      ],
    });
  });
});
