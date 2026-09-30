import { describe, expect, it, vi } from "vitest";

import type {
  GameView,
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";
import {
  createGamePanelProps,
  deadlineRefreshDelay,
} from "./game-controller.js";
import {
  mapGameDisplay,
  type PendingReactionSubmission,
} from "./game-mapper.js";

const tile = {
  id: 4,
  kind: { type: "suited", rank: 2, suit: "characters" },
} as const;
const actor = { id: "actor:one", displayName: "Player" };
const baseGame: GameView = {
  deadlineAt: 1000,
  phase: "awaiting-discard",
  turn: "east",
  wallRemaining: 60,
  players: [
    { seat: "east", bonuses: [], concealedCount: 1, discards: [], melds: [] },
  ],
  viewerHand: [tile],
  viewerActions: { self: [{ type: "game/discard", tileId: 4 }] },
};
function snapshot(game: GameView = baseGame): ViewerSafeTableSnapshot {
  return {
    type: "table/snapshot",
    protocolVersion: 1,
    stateVersion: 8,
    view: {
      tableId: "table",
      phase: "playing",
      game,
      seats: [{ seat: "east", occupant: actor, ready: true, autopilot: true }],
      spectators: [],
      viewer: { role: "player", actor, seat: "east" },
    },
  };
}
function input(game: GameView = baseGame) {
  return {
    snapshot: snapshot(game),
    connected: true,
    latestReceipt: undefined,
    now: 999,
  };
}
const reactionGame: GameView = {
  ...baseGame,
  phase: "awaiting-discard-reactions",
  reaction: {
    kind: "discard",
    sourceSeat: "south",
    sourceTile: tile,
    windowId: "reaction:8",
  },
  viewerActions: {
    self: [],
    reaction: {
      windowId: "reaction:8",
      status: "open",
      actions: [
        { type: "pass" },
        { type: "win" },
        { type: "chow", handTileIds: [0, 8] },
        { type: "pung", handTileIds: [5, 6] },
        { type: "kong", handTileIds: [5, 6, 7] },
      ],
    },
  },
};
const rejected: TableReceipt = {
  type: "table/receipt",
  protocolVersion: 1,
  stateVersion: 8,
  commandId: "command",
  outcome: "rejected",
  error: { code: "too-late", message: "The reaction closed." },
};

describe("game controller", () => {
  it("maps semantic intents to exactly the actions supplied by the server", () => {
    const self = [
      { type: "game/draw" },
      { type: "game/discard", tileId: 4 },
      { type: "game/declare-concealed-kong", tileIds: [4, 5, 6, 7] },
      { type: "game/propose-added-kong", meldId: "meld:one", tileId: 4 },
      { type: "game/declare-win" },
    ] as const;
    const send = vi.fn(() => true);
    const props = createGamePanelProps(
      { ...input({ ...baseGame, viewerActions: { self } }), onCommand: send },
      vi.fn(),
    );
    props.onDraw();
    props.onDiscard(4);
    props.onConcealedKong("4:5:6:7");
    props.onAddedKong("meld:one:4");
    props.onWin();
    expect(send.mock.calls).toEqual(self.map((command) => [command]));
    props.onDiscard(9);
    props.onConcealedKong("0:1:2:3");
    props.onAddedKong("missing");
    expect(send).toHaveBeenCalledTimes(5);
    expect(props.game?.hand).toEqual([
      { id: 4, kind: tile.kind, label: "2 characters", discardDisabled: false },
    ]);
    expect(props.game?.players[0]?.autopilot).toBe(true);
  });

  it("preserves each exact reaction choice and records only successful sends", () => {
    const sent = vi.fn();
    const send = vi.fn(() => true);
    const current = input(reactionGame);
    const props = createGamePanelProps({ ...current, onCommand: send }, sent);
    for (const action of props.game?.reaction?.actions ?? [])
      props.onReact(action.id);
    expect(send.mock.calls).toEqual(
      reactionGame.viewerActions?.reaction?.actions.map((response) => [
        { type: "game/react", windowId: "reaction:8", response },
      ]),
    );
    expect(sent).toHaveBeenCalledTimes(5);
    expect(sent).toHaveBeenLastCalledWith({
      receiptAtSubmission: undefined,
      snapshotAtSubmission: current.snapshot,
      windowId: "reaction:8",
    });
    send.mockReturnValue(false);
    sent.mockClear();
    props.onReact("pass");
    expect(sent).not.toHaveBeenCalled();
    props.onReact("invented");
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("keeps pending on applied receipts and releases it on rejection, resync, or a new window", () => {
    const current = input(reactionGame);
    const pendingReaction: PendingReactionSubmission = {
      snapshotAtSubmission: current.snapshot,
      receiptAtSubmission: undefined,
      windowId: "reaction:8",
    };
    const pending = { ...current, pendingReaction };
    expect(mapGameDisplay(pending)?.reaction?.status).toBe("submitted");
    expect(
      mapGameDisplay({
        ...pending,
        latestReceipt: { ...rejected, outcome: "applied" },
      })?.reaction?.status,
    ).toBe("submitted");
    const rejectedDisplay = mapGameDisplay({
      ...pending,
      latestReceipt: rejected,
    });
    expect(rejectedDisplay?.reaction?.status).toBe("open");
    expect(rejectedDisplay?.rejectionMessage).toBe("The reaction closed.");
    expect(
      mapGameDisplay({ ...pending, connected: false })?.reaction?.status,
    ).toBe("open");
    expect(
      mapGameDisplay({ ...pending, snapshot: { ...current.snapshot } })
        ?.reaction?.status,
    ).toBe("open");
    expect(
      mapGameDisplay({
        ...pending,
        pendingReaction: { ...pendingReaction, windowId: "older" },
      })?.reaction?.status,
    ).toBe("open");
    const send = vi.fn(() => true);
    createGamePanelProps({ ...pending, onCommand: send }, vi.fn()).onReact(
      "pass",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("uses server-submitted state after reconnect and leaves spectators waiting", () => {
    const submitted = {
      ...reactionGame,
      viewerActions: {
        self: [],
        reaction: { windowId: "reaction:8", status: "submitted", actions: [] },
      },
    } as const;
    expect(mapGameDisplay(input(submitted))?.reaction?.status).toBe(
      "submitted",
    );
    const {
      viewerActions: _actions,
      viewerHand: _hand,
      ...publicGame
    } = reactionGame;
    void _actions;
    void _hand;
    expect(mapGameDisplay(input(publicGame))).toMatchObject({
      hand: null,
      reaction: { status: "waiting", actions: [] },
      draw: null,
      win: null,
    });
  });

  it.each([999, 1000, 1001])(
    "gates controls at deadline boundary %s and keeps authority on the server",
    (now) => {
      const send = vi.fn(() => true);
      const props = createGamePanelProps(
        { ...input(), now, onCommand: send },
        vi.fn(),
      );
      expect(props.game?.hand?.[0]?.discardDisabled).toBe(now >= 1000);
      props.onDiscard(4);
      expect(send).toHaveBeenCalledTimes(now < 1000 ? 1 : 0);
      if (now >= 1000)
        expect(props.game?.deadlineStatus).toContain(
          "waiting for the server outcome",
        );
    },
  );

  it("disables all choices while disconnected, and enables only newly supplied actions", () => {
    const send = vi.fn(() => true);
    const props = createGamePanelProps(
      { ...input(reactionGame), connected: false, onCommand: send },
      vi.fn(),
    );
    expect(
      props.game?.reaction?.actions.every((action) => action.disabled),
    ).toBe(true);
    props.onReact("pass");
    props.onDiscard(4);
    props.onDraw();
    props.onWin();
    expect(send).not.toHaveBeenCalled();
    expect(
      mapGameDisplay(input({ ...baseGame, viewerActions: { self: [] } }))
        ?.hand?.[0]?.discardDisabled,
    ).toBe(true);
  });

  it("stops deadline refreshes after expiry and handles absent, changed, or distant deadlines", () => {
    expect(deadlineRefreshDelay(null, 0)).toBeNull();
    expect(deadlineRefreshDelay(1000, 999)).toBe(1);
    expect(deadlineRefreshDelay(1000, 1000)).toBeNull();
    expect(deadlineRefreshDelay(1000, 1001, 999)).toBe(0);
    expect(deadlineRefreshDelay(1000, 1001)).toBeNull();
    expect(deadlineRefreshDelay(4000, 1001)).toBe(1000);
  });

  it("maps absent games, terminal states, pending deadlines and abandoned tables", () => {
    const current = input();
    const { game: _game, ...view } = current.snapshot.view;
    void _game;
    expect(
      mapGameDisplay({ ...current, snapshot: { ...current.snapshot, view } }),
    ).toBeNull();
    expect(
      mapGameDisplay(input({ ...baseGame, deadlineAt: null }))?.deadlineStatus,
    ).toBe("Server deadline is pending.");
    for (const phase of ["complete", "exhausted"] as const) {
      expect(
        mapGameDisplay(
          input({ ...baseGame, phase, viewerActions: { self: [] } }),
        ),
      ).toMatchObject({
        deadlineStatus: null,
        draw: null,
        win: null,
        heading:
          phase === "complete"
            ? "The hand is complete"
            : "The wall is exhausted",
      });
    }
    expect(
      mapGameDisplay({
        ...current,
        snapshot: {
          ...current.snapshot,
          view: { ...current.snapshot.view, phase: "abandoned" },
        },
      })?.abandoned,
    ).toBe(true);
  });
});

it("maps dedicated bot and human player identities without treating autopilot as a bot", () => {
  const current = input();
  const human = mapGameDisplay(current)?.players[0];
  expect(human).toMatchObject({
    kind: "human",
    displayName: "Player",
    autopilot: true,
    isTurn: true,
  });
  const botSnapshot: ViewerSafeTableSnapshot = {
    ...current.snapshot,
    view: {
      ...current.snapshot.view,
      seats: current.snapshot.view.seats.map((seat) => ({
        ...seat,
        autopilot: false,
        occupant: { id: "bot:dedicated", displayName: "Bot East" },
      })),
    },
  };
  const bot = mapGameDisplay({ ...current, snapshot: botSnapshot })?.players[0];
  expect(bot).toMatchObject({
    kind: "bot",
    displayName: "Bot East",
    autopilot: false,
    isTurn: true,
  });
  expect(bot).not.toHaveProperty("id");
});
