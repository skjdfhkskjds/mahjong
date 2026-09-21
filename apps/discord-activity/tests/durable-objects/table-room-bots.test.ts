import { describe, expect, it } from "vitest";
import type { GameViewV2 } from "@mahjong/rules-hong-kong";
import {
  botLegalMoves,
  chooseBotMove,
} from "../../src/worker/durable-objects/table-room/table-room-bots.js";

describe("random bot policy", () => {
  // Synthetic viewer projections: no canonical state or opponent hands enter
  // the policy. The engine remains responsible for offering legal actions.
  const self = [
    { type: "game/draw" },
    { type: "game/discard", tileId: 4 },
    { type: "game/declare-win" },
    { type: "game/declare-concealed-kong", tileIds: [0, 1, 2, 3] },
    { type: "game/propose-added-kong", meldId: "pung", tileId: 4 },
  ] as const;
  const view = {
    phase: "awaiting-discard",
    players: [],
    turn: "east",
    wallRemaining: 40,
    viewerActions: { self },
  } as unknown as GameViewV2;

  it("selects every offered self action using only the supplied viewer actions", () => {
    self.forEach((action, index) => {
      expect(chooseBotMove(view, (index + 0.5) / self.length)).toEqual(action);
    });
    expect(botLegalMoves({ ...view, viewerActions: { self: [] } })).toEqual([]);
  });

  it("selects legal reactions, including wins and kongs, and does not resubmit private intent", () => {
    const actions = [
      { type: "pass" },
      { type: "win" },
      { type: "chow", handTileIds: [4, 8] },
      { type: "pung", handTileIds: [0, 1] },
      { type: "kong", handTileIds: [0, 1, 2] },
    ] as const;
    const reacting = {
      ...view,
      viewerActions: {
        self: [],
        reaction: { status: "open", windowId: "window", actions },
      },
    } as unknown as GameViewV2;
    actions.forEach((response, index) => {
      expect(chooseBotMove(reacting, (index + 0.5) / actions.length)).toEqual({
        type: "game/react",
        response,
        windowId: "window",
      });
    });
    const submitted = {
      ...reacting,
      viewerActions: {
        self: [],
        reaction: { status: "submitted", windowId: "window", actions: [] },
      },
    } as unknown as GameViewV2;
    expect(chooseBotMove(submitted, 0)).toBeUndefined();
  });

  it("stops at terminal hands and rejects invalid random inputs", () => {
    expect(chooseBotMove({ ...view, phase: "complete" }, 0)).toBeUndefined();
    expect(chooseBotMove({ ...view, phase: "exhausted" }, 0)).toBeUndefined();
    for (const random of [-1, 1, NaN, Infinity])
      expect(() => chooseBotMove(view, random)).toThrow();
  });
});
