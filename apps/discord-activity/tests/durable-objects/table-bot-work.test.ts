import { describe, expect, it, vi } from "vitest";
import {
  BOT_MOVE_DELAY_MS,
  prepareBotWork,
  type BotJob,
  type BotWorkPlayer,
} from "../../src/worker/durable-objects/table-room/table-bot-work.js";
import type { PlayerControl } from "../../src/worker/durable-objects/table-room/table-player-control.js";

function player(
  actorId: string,
  controller: PlayerControl["controller"] = "BOT",
  generation = 3,
  target: string | undefined = "reaction:window",
): BotWorkPlayer {
  return {
    control: { actorId, kind: "HUMAN", controller, generation },
    target,
  };
}

function job(actorId: string): BotJob {
  return {
    actorId,
    target: "reaction:window",
    commandId: `existing-${actorId}`,
    dueAt: 1_000,
    controllerGeneration: 3,
  };
}

describe("generation-bound bot work planning", () => {
  it("schedules four substituted humans under their existing identities", () => {
    const actorIds = [
      "east-player",
      "south-player",
      "west-player",
      "north-player",
    ];
    let nextId = 0;
    const changes = prepareBotWork({
      players: actorIds.map((actorId) => player(actorId)),
      jobs: [],
      now: 500,
      abandoned: false,
      createCommandId: () => `new-${String(++nextId)}`,
    });
    expect(changes.cancelActorIds).toEqual([]);
    expect(changes.upsert).toEqual(
      actorIds.map((actorId, index) => ({
        actorId,
        target: "reaction:window",
        commandId: `new-${String(index + 1)}`,
        dueAt: 500 + BOT_MOVE_DELAY_MS,
        controllerGeneration: 3,
      })),
    );
  });

  it("replaces a job when controller generation changes even if the target is unchanged", () => {
    const changes = prepareBotWork({
      players: [player("returning-player", "BOT", 5)],
      jobs: [job("returning-player")],
      now: 2_000,
      abandoned: false,
      createCommandId: () => "new-generation",
    });
    expect(changes).toEqual({
      cancelActorIds: [],
      upsert: [
        {
          ...job("returning-player"),
          commandId: "new-generation",
          controllerGeneration: 5,
          dueAt: 2_000 + BOT_MOVE_DELAY_MS,
        },
      ],
    });
  });

  it("cancels reconnecting human and removed-player work without scheduling replacements", () => {
    const createCommandId = vi.fn(() => "unexpected");
    expect(
      prepareBotWork({
        players: [player("returning-player", "HUMAN", 4)],
        jobs: [job("returning-player"), job("removed-player")],
        now: 2_000,
        abandoned: false,
        createCommandId,
      }),
    ).toEqual({
      cancelActorIds: ["returning-player", "removed-player"],
      upsert: [],
    });
    expect(createCommandId).not.toHaveBeenCalled();
  });

  it("cancels every job while abandoned and creates fresh work when resumed", () => {
    const players = [player("first"), player("second")];
    const createCommandId = vi.fn(() => "resumed");
    expect(
      prepareBotWork({
        players,
        jobs: [job("first"), job("second")],
        now: 2_000,
        abandoned: true,
        createCommandId,
      }),
    ).toEqual({ cancelActorIds: ["first", "second"], upsert: [] });
    expect(createCommandId).not.toHaveBeenCalled();
    const resumed = prepareBotWork({
      players: [players[0] ?? player("first")],
      jobs: [],
      now: 3_000,
      abandoned: false,
      createCommandId,
    });
    expect(resumed.upsert).toEqual([
      {
        ...job("first"),
        commandId: "resumed",
        dueAt: 3_000 + BOT_MOVE_DELAY_MS,
      },
    ]);
  });

  it("cancels submitted or terminal actions whose permitted view has no target", () => {
    expect(
      prepareBotWork({
        players: [{ ...player("finished"), target: undefined }],
        jobs: [job("finished")],
        now: 2_000,
        abandoned: false,
        createCommandId: () => "unexpected",
      }),
    ).toEqual({ cancelActorIds: ["finished"], upsert: [] });
  });

  it("retains stable reaction jobs and their original deadlines across private intent changes", () => {
    const existing = [job("submitted"), job("pending")];
    const createCommandId = vi.fn(() => "unexpected");
    const changes = prepareBotWork({
      players: [
        { ...player("submitted"), target: undefined },
        player("pending"),
      ],
      jobs: existing,
      now: 9_000,
      abandoned: false,
      createCommandId,
    });
    expect(changes).toEqual({ cancelActorIds: ["submitted"], upsert: [] });
    expect(
      prepareBotWork({
        players: [player("pending")],
        jobs: [job("pending")],
        now: 10_000,
        abandoned: false,
        createCommandId,
      }),
    ).toEqual({ cancelActorIds: [], upsert: [] });
    expect(createCommandId).not.toHaveBeenCalled();
    expect(existing).toEqual([job("submitted"), job("pending")]);
  });

  it("schedules dedicated bots by controller authority and replaces changed turn targets", () => {
    const dedicated: BotWorkPlayer = {
      control: {
        actorId: "bot:dedicated",
        kind: "BOT",
        controller: "BOT",
        generation: 3,
      },
      target: "turn:42",
    };
    expect(
      prepareBotWork({
        players: [dedicated],
        jobs: [job("bot:dedicated")],
        now: 2_000,
        abandoned: false,
        createCommandId: () => "next-turn",
      }),
    ).toEqual({
      cancelActorIds: [],
      upsert: [
        {
          ...job("bot:dedicated"),
          target: "turn:42",
          commandId: "next-turn",
          dueAt: 2_000 + BOT_MOVE_DELAY_MS,
        },
      ],
    });
  });
});
