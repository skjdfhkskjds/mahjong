import { describe, expect, it } from "vitest";

import { seat, seats } from "../table/seat.js";
import type { GameLifecycle } from "./game-engine-contracts.js";
import {
  reactionResponderOrder,
  transitionLifecycle,
} from "./game-lifecycle.js";

const lifecycle: GameLifecycle<"discard"> = {
  participants: seats.map((seat) => ({ actorId: seat, seat })),
  activeSeat: seat("north"),
  phase: { kind: "turn", stage: "discard", generation: 1 },
};

describe("shared turn order", () => {
  it.each([
    ["east", ["south", "west", "north"]],
    ["south", ["west", "north", "east"]],
    ["west", ["north", "east", "south"]],
    ["north", ["east", "south", "west"]],
  ] as const)("opens turn-order responders after %s", (source, expected) => {
    expect(reactionResponderOrder(seat(source))).toEqual(expected);
  });

  it("retains a proposer for an interrupt window", () => {
    expect(
      transitionLifecycle(lifecycle, {
        kind: "reaction",
        sourceSeat: seat("north"),
        active: "source",
        generation: 2,
        windowId: "proposal",
      }),
    ).toEqual({
      participants: lifecycle.participants,
      activeSeat: seat("north"),
      phase: {
        kind: "reaction",
        window: {
          id: "proposal",
          generation: 2,
          responders: [seat("east"), seat("south"), seat("west")],
          submitted: [],
        },
      },
    });
  });

  it("selects an interrupt winner instead of normal advancement", () => {
    expect(
      transitionLifecycle(lifecycle, {
        kind: "turn",
        stage: "discard",
        generation: 2,
        next: { kind: "select", seat: seat("west") },
      }),
    ).toMatchObject({
      activeSeat: "west",
      phase: { kind: "turn", stage: "discard", generation: 2 },
    });
    expect(
      transitionLifecycle(lifecycle, { kind: "finished", seat: seat("west") }),
    ).toMatchObject({ activeSeat: "west", phase: { kind: "finished" } });
  });
});
