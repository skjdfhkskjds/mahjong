import { describe, expect, it } from "vitest";
import {
  applyGameCommandV2,
  startHongKongV2Game,
} from "@mahjong/rules-hong-kong";

import type { PersistedDeadline } from "./table-deadline-application.js";
import { prepareGameDeadlines } from "./table-game-scheduling.js";
import type { PlayerControl } from "./table-player-control.js";
import { tableGameDeadline } from "./table-room-game-engine.js";

function gameFixture() {
  const started = startHongKongV2Game(
    { east: "east", south: "south", west: "west", north: "north" },
    Uint8Array.from({ length: 1_028 }, (_, index) => (index * 41 + 17) & 0xff),
  );
  const target = tableGameDeadline(started.state);
  if (target?.kind !== "turn") throw new Error("Expected initial turn.");
  const control: PlayerControl = {
    actorId: target.actorId,
    kind: "HUMAN",
    controller: "HUMAN",
    generation: 4,
  };
  const deadline: PersistedDeadline = {
    deadlineId: target.deadlineId,
    dueAt: 60_000,
    kind: target.kind,
    payload: target.payload,
    processedAt: null,
    status: "pending",
    targetGeneration: target.targetGeneration,
  };
  const input = {
    state: started.state,
    now: 1_000,
    deadlines: [] as readonly PersistedDeadline[],
    controls: [control],
    connectedActorIds: new Set([target.actorId]),
  };
  return { input, deadline, target, control };
}

describe("controller-aware game deadline scheduling", () => {
  it("keeps a connected human turn at sixty seconds and does not extend pending work", () => {
    const { input, deadline } = gameFixture();
    expect(prepareGameDeadlines(input).schedule[0]?.dueAt).toBe(61_000);
    expect(prepareGameDeadlines({ ...input, deadlines: [deadline] })).toEqual({
      cancel: [],
      schedule: [],
    });
    expect(
      prepareGameDeadlines({ ...input, connectedActorIds: new Set() }),
    ).toEqual({ cancel: [], schedule: [] });
  });

  it("cancels a pending human timer when BOT controls the current turn", () => {
    const { input, deadline, control } = gameFixture();
    expect(
      prepareGameDeadlines({
        ...input,
        deadlines: [deadline],
        controls: [{ ...control, controller: "BOT" }],
      }),
    ).toEqual({ cancel: [deadline.deadlineId], schedule: [] });
    expect(
      prepareGameDeadlines({
        ...input,
        deadlines: [deadline],
        controls: [{ ...control, kind: "BOT", controller: "BOT" }],
        processingDeadlineId: deadline.deadlineId,
      }),
    ).toEqual({ cancel: [], schedule: [] });
  });

  it("resumes a cancelled turn with controller generation in its stable identity", () => {
    const { input, deadline } = gameFixture();
    const cancelled = { ...deadline, status: "cancelled" as const };
    const prepared = prepareGameDeadlines({ ...input, deadlines: [cancelled] });
    expect(prepared.schedule).toEqual([
      {
        deadlineId: `${deadline.deadlineId}:controller:4`,
        dueAt: 61_000,
        kind: deadline.kind,
        payload: deadline.payload,
        status: "pending",
        targetGeneration: deadline.targetGeneration,
      },
    ]);
    const pending = prepared.schedule[0];
    if (pending === undefined) throw new Error("Expected resumed deadline.");
    expect(
      prepareGameDeadlines({
        ...input,
        now: 2_000,
        deadlines: [cancelled, { ...pending, processedAt: null }],
      }),
    ).toEqual({ cancel: [], schedule: [] });
  });

  it("retains eight-second reaction deadlines independently of controllers", () => {
    const { input, control } = gameFixture();
    const player = [
      input.state.players.east,
      input.state.players.south,
      input.state.players.west,
      input.state.players.north,
    ].find(({ actorId }) => actorId === control.actorId);
    const tileId = player?.hand[0];
    if (tileId === undefined) throw new Error("Expected dealer tile.");
    const discarded = applyGameCommandV2(input.state, control.actorId, {
      type: "game/discard",
      tileId,
    });
    if (!discarded.accepted) throw new Error(discarded.error.message);
    if (discarded.state === undefined)
      throw new Error("Expected reaction state.");
    const prepared = prepareGameDeadlines({
      ...input,
      state: discarded.state,
      controls: [{ ...control, controller: "BOT" }],
      connectedActorIds: new Set(),
    });
    expect(prepared.schedule[0]).toMatchObject({
      kind: "reaction",
      dueAt: 9_000,
    });
  });
});
