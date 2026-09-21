import { describe, expect, it, vi } from "vitest";

import type {
  GameView,
  PublicTileView,
  ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";
import { createGamePanelProps } from "./game-controller.js";
import { mapGameDisplay } from "./game-mapper.js";

const actor = { id: "viewer", displayName: "Ada" };
const handTile: PublicTileView = {
  id: 44,
  kind: { type: "suited", suit: "circles", rank: 3 },
};
const publicTile: PublicTileView = {
  id: 48,
  kind: { type: "suited", suit: "circles", rank: 4 },
};
const sourceTile: PublicTileView = {
  id: 52,
  kind: { type: "suited", suit: "circles", rank: 5 },
};
const baseGame: GameView = {
  deadlineAt: 2000,
  phase: "awaiting-discard-reactions",
  turn: "south",
  wallRemaining: 60,
  players: [
    {
      seat: "east",
      bonuses: [],
      concealedCount: 1,
      discards: [publicTile],
      melds: [],
    },
    {
      seat: "south",
      bonuses: [],
      concealedCount: 13,
      discards: [sourceTile],
      melds: [],
    },
  ],
  viewerHand: [handTile],
  reaction: {
    kind: "discard",
    sourceSeat: "south",
    sourceTile,
    windowId: "reaction:1",
  },
  viewerActions: {
    self: [],
    reaction: {
      status: "open",
      windowId: "reaction:1",
      actions: [
        { type: "chow", handTileIds: [44, 48] },
        { type: "pass" },
        { type: "win" },
      ],
    },
  },
};

function input(game: GameView = baseGame) {
  const snapshot: ViewerSafeTableSnapshot = {
    type: "table/snapshot",
    protocolVersion: 2,
    stateVersion: 1,
    view: {
      phase: "playing",
      game,
      tableId: "table:1",
      seats: [{ seat: "east", occupant: actor, ready: true, autopilot: true }],
      spectators: [],
      viewer: { role: "player", actor, seat: "east" },
    },
  };
  return { snapshot, connected: true, latestReceipt: undefined, now: 1000 };
}

describe("game artwork mapping", () => {
  it("resolves reaction choices only from the viewer hand and public tiles", () => {
    const display = mapGameDisplay(input());
    expect(display?.reaction?.actions[0]).toEqual({
      id: "chow:44:48",
      label: "Chow with 3 circles, 4 circles",
      artworkAction: "chow",
      disabled: false,
      tiles: [
        { ...handTile, label: "3 circles" },
        { ...publicTile, label: "4 circles" },
      ],
    });
    expect(display?.reaction?.actions[1]?.artworkAction).toBe("pass");
    expect(display?.reaction?.actions[2]?.artworkAction).toBe("win");
  });

  it("does not reconstruct a tile face from a valid but unseen physical ID", () => {
    const display = mapGameDisplay(
      input({
        ...baseGame,
        viewerActions: {
          self: [],
          reaction: {
            status: "open",
            windowId: "reaction:1",
            actions: [{ type: "chow", handTileIds: [44, 72] }],
          },
        },
      }),
    );
    expect(display?.reaction?.actions[0]?.label).toBe(
      "Chow with 3 circles, Unknown tile",
    );
    expect(display?.reaction?.actions[0]?.tiles?.[1]).toEqual({
      id: 72,
      label: "Unknown tile",
    });
    expect(display?.reaction?.actions[0]?.tiles?.[1]).not.toHaveProperty(
      "kind",
    );
  });

  it("uses exposed source and meld tiles without introducing private opponent tiles", () => {
    const display = mapGameDisplay(
      input({
        ...baseGame,
        players: [
          {
            seat: "east",
            concealedCount: 1,
            bonuses: [],
            discards: [],
            melds: [
              {
                id: "meld:1",
                kind: "pung",
                exposure: "exposed",
                tileIds: [publicTile],
              },
            ],
          },
        ],
        viewerActions: {
          self: [],
          reaction: {
            status: "open",
            windowId: "reaction:1",
            actions: [{ type: "chow", handTileIds: [48, 52] }],
          },
        },
      }),
    );
    expect(display?.reaction?.actions[0]?.tiles).toEqual([
      { ...publicTile, label: "4 circles" },
      { ...sourceTile, label: "5 circles" },
    ]);
  });

  it("keeps player identity separate from artwork and autopilot remains human", () => {
    const display = mapGameDisplay(input());
    expect(display?.players[0]).toMatchObject({
      displayName: "Ada",
      kind: "human",
      autopilot: true,
      isTurn: false,
    });
    expect(display?.players[1]).toMatchObject({
      displayName: "south",
      kind: "human",
      isTurn: true,
    });
    expect(
      mapGameDisplay(input({ ...baseGame, phase: "exhausted" }))?.players.every(
        (player) => !player.isTurn,
      ),
    ).toBe(true);
  });

  it("retains exact reaction callback IDs while using descriptive action labels", () => {
    const onCommand = vi.fn(() => true);
    const onSent = vi.fn();
    const props = createGamePanelProps({ ...input(), onCommand }, onSent);
    const action = props.game?.reaction?.actions[0];
    if (!action) throw new Error("Reaction fixture is missing.");
    props.onReact(action.id);
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({
      type: "game/react",
      windowId: "reaction:1",
      response: { type: "chow", handTileIds: [44, 48] },
    });
    expect(onSent).toHaveBeenCalledOnce();
  });

  it("maps self kong artwork from visible tiles while retaining exact commands", () => {
    const concealed = {
      type: "game/declare-concealed-kong",
      tileIds: [44, 45, 46, 47],
    } as const;
    const added = {
      type: "game/propose-added-kong",
      meldId: "meld:1",
      tileId: 44,
    } as const;
    const onCommand = vi.fn(() => true);
    const props = createGamePanelProps(
      {
        ...input({
          ...baseGame,
          phase: "awaiting-discard",
          viewerActions: {
            self: [
              concealed,
              added,
              { type: "game/draw" },
              { type: "game/declare-win" },
            ],
          },
        }),
        onCommand,
      },
      vi.fn(),
    );
    expect(props.game?.concealedKongs[0]).toMatchObject({
      id: "44:45:46:47",
      artworkAction: "kong",
      label:
        "Concealed kong (3 circles, Unknown tile, Unknown tile, Unknown tile)",
    });
    expect(props.game?.addedKongs[0]).toMatchObject({
      id: "meld:1:44",
      artworkAction: "kong",
      label: "Add 3 circles to kong",
      tiles: [{ ...handTile, label: "3 circles" }],
    });
    expect(props.game?.draw?.artworkAction).toBe("draw");
    expect(props.game?.win?.artworkAction).toBe("win");
    props.onConcealedKong("44:45:46:47");
    props.onAddedKong("meld:1:44");
    expect(onCommand.mock.calls).toEqual([[concealed], [added]]);
  });
});
