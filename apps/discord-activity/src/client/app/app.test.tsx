import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  TableCommand,
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../adapters/transport/table-socket-status.js";
import {
  GamePanel,
  reactionSubmissionPending,
  TableCommandButton,
} from "./app.js";

const actors = [
  { displayName: "east player", id: "actor:east" },
  { displayName: "south player", id: "actor:south" },
  { displayName: "west player", id: "actor:west" },
  { displayName: "north player", id: "actor:north" },
] as const;

const snapshot: ViewerSafeTableSnapshot = {
  protocolVersion: 2,
  stateVersion: 12,
  type: "table/snapshot",
  view: {
    game: {
      deadlineAt: Date.now() + 60_000,
      phase: "awaiting-dealer-discard",
      players: [
        {
          bonuses: [
            {
              id: 136,
              kind: {
                family: "season",
                matchingSeat: "east",
                name: "spring",
                number: 1,
                type: "bonus",
              },
            },
          ],
          concealedCount: 1,
          discards: [
            {
              id: 0,
              kind: { rank: 1, suit: "characters", type: "suited" },
            },
          ],
          melds: [],
          seat: "east",
        },
        ...(["south", "west", "north"] as const).map((seat) => ({
          bonuses: [],
          concealedCount: 13,
          discards: [],
          melds: [],
          seat,
        })),
      ],
      turn: "east",
      viewerActions: {
        self: [{ type: "game/discard", tileId: 4 }],
      },
      viewerHand: [
        {
          id: 4,
          kind: { rank: 2, suit: "characters", type: "suited" },
        },
      ],
      wallRemaining: 87,
    },
    phase: "playing",
    seats: (["east", "south", "west", "north"] as const).map((seat, index) => ({
      occupant: actors[index] ?? null,
      autopilot: false,
      ready: true,
      seat,
    })),
    spectators: [],
    tableId: "table-test",
    viewer: { actor: actors[0], role: "player", seat: "east" },
  },
};

const rejectedReceipt: TableReceipt = {
  commandId: "game-command",
  error: { code: "not-your-turn", message: "Another player has the turn." },
  outcome: "rejected",
  protocolVersion: 2,
  stateVersion: 12,
  type: "table/receipt",
};

describe("GamePanel", () => {
  it("dispatches exact start, draw, and reaction commands from command buttons", () => {
    const onCommand = vi.fn((command: TableCommand) => {
      void command;
      return true;
    });
    const commands = [
      { type: "game/start" },
      { type: "game/draw" },
      {
        type: "game/react",
        windowId: "discard:12",
        response: { type: "pass" },
      },
      {
        type: "game/react",
        windowId: "discard:12",
        response: { type: "chow", handTileIds: [4, 8] },
      },
      {
        type: "game/react",
        windowId: "discard:12",
        response: { type: "kong", handTileIds: [4, 5, 6] },
      },
      {
        type: "game/react",
        windowId: "discard:12",
        response: { type: "win" },
      },
    ] as const;

    for (const command of commands) {
      const button = TableCommandButton({
        children: command.type,
        command,
        disabled: false,
        onCommand,
      });
      expect(button.props.disabled).toBe(false);
      button.props.onClick?.({} as never);
    }
    expect(onCommand.mock.calls.map(([command]) => command)).toEqual(commands);

    const disabled = TableCommandButton({
      children: "disabled",
      command: { type: "game/draw" },
      disabled: true,
      onCommand,
    });
    expect(disabled.props.disabled).toBe(true);
  });

  it("clears an unconfirmed local reaction across reconnect snapshots", () => {
    let pending:
      | {
          readonly receiptAtSubmission: TableReceipt | undefined;
          readonly snapshotAtSubmission: ViewerSafeTableSnapshot;
          readonly windowId: string;
        }
      | undefined;
    const button = TableCommandButton({
      children: "Pass",
      command: {
        type: "game/react",
        response: { type: "pass" },
        windowId: "discard:12",
      },
      disabled: false,
      onCommand: () => true,
      onSent: () => {
        pending = {
          receiptAtSubmission: undefined,
          snapshotAtSubmission: snapshot,
          windowId: "discard:12",
        };
      },
    });
    button.props.onClick?.({} as never);
    if (pending === undefined)
      throw new Error("Reaction click did not submit.");
    expect(
      reactionSubmissionPending(pending, {
        connected: true,
        latestReceipt: undefined,
        snapshot,
        windowId: "discard:12",
      }),
    ).toBe(true);
    expect(
      reactionSubmissionPending(pending, {
        connected: false,
        latestReceipt: undefined,
        snapshot,
        windowId: "discard:12",
      }),
    ).toBe(false);
    expect(
      reactionSubmissionPending(pending, {
        connected: true,
        latestReceipt: undefined,
        snapshot: { ...snapshot },
        windowId: "discard:12",
      }),
    ).toBe(false);
    expect(
      reactionSubmissionPending(pending, {
        connected: true,
        latestReceipt: {
          commandId: "reaction-command",
          outcome: "applied",
          protocolVersion: 2,
          stateVersion: 12,
          type: "table/receipt",
        },
        snapshot,
        windowId: "discard:12",
      }),
    ).toBe(true);
  });

  it("renders exact public tiles, the private hand, and gameplay errors", () => {
    const markup = renderToStaticMarkup(
      <GamePanel
        connected
        latestReceipt={rejectedReceipt}
        onCommand={vi.fn()}
        snapshot={snapshot}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Another player has the turn.");
    expect(markup).toContain('aria-label="east exposed bonuses"');
    expect(markup).toContain("spring");
    expect(markup).toContain('aria-label="east discards"');
    expect(markup).toContain("1 characters");
    expect(markup).toContain('aria-label="Your concealed tiles"');
    expect(markup).toContain("2 characters");
  });

  it("renders public melds and every exact private action", () => {
    const actionSnapshot = {
      ...snapshot,
      view: {
        ...snapshot.view,
        game: {
          ...snapshot.view.game,
          players: snapshot.view.game?.players.map((player) =>
            player.seat === "south"
              ? {
                  ...player,
                  melds: [
                    {
                      claimedTileId: 8,
                      exposure: "exposed",
                      id: "meld:1",
                      kind: "pung",
                      sourceSeat: "west",
                      tileIds: [8, 9, 10].map((id) => ({
                        id,
                        kind: {
                          rank: 3,
                          suit: "characters",
                          type: "suited",
                        },
                      })),
                    },
                    {
                      exposure: "concealed",
                      id: "meld:concealed-kong",
                      kind: "kong",
                      kongKind: "concealed",
                      tileIds: [12, 13, 14, 15].map((id) => ({
                        id,
                        kind: {
                          rank: 4,
                          suit: "characters",
                          type: "suited",
                        },
                      })),
                    },
                    {
                      claimedTileId: 16,
                      exposure: "exposed",
                      id: "meld:exposed-kong",
                      kind: "kong",
                      kongKind: "exposed",
                      sourceSeat: "west",
                      tileIds: [16, 17, 18, 19].map((id) => ({
                        id,
                        kind: {
                          rank: 5,
                          suit: "characters",
                          type: "suited",
                        },
                      })),
                    },
                    {
                      claimedTileId: 20,
                      exposure: "exposed",
                      id: "meld:added-kong",
                      kind: "kong",
                      kongKind: "added",
                      sourceSeat: "north",
                      tileIds: [20, 21, 22, 23].map((id) => ({
                        id,
                        kind: {
                          rank: 6,
                          suit: "characters",
                          type: "suited",
                        },
                      })),
                    },
                  ],
                }
              : player,
          ),
          viewerActions: {
            self: [
              { type: "game/discard", tileId: 4 },
              {
                type: "game/declare-concealed-kong",
                tileIds: [4, 5, 6, 7],
              },
              {
                type: "game/propose-added-kong",
                meldId: "meld:1",
                tileId: 4,
              },
              { type: "game/declare-win" },
            ],
          },
        },
      },
    } as unknown as ViewerSafeTableSnapshot;
    const markup = renderToStaticMarkup(
      <GamePanel
        connected
        latestReceipt={undefined}
        onCommand={vi.fn()}
        snapshot={actionSnapshot}
      />,
    );

    expect(markup).toContain("exposed pung");
    expect(markup).toContain("from west");
    expect(markup).toContain("concealed kong");
    expect(markup).toContain("exposed kong");
    expect(markup).toContain("added kong");
    expect(markup).not.toContain("concealed concealed");
    expect(markup).not.toContain("exposed exposed");
    expect(markup).toContain("Concealed kong");
    expect(markup).toContain("Add tile #4 to kong");
    expect(markup).toContain("Declare self-drawn win");
  });

  it("renders reaction controls, disables submitted responses, and honors local expiry", () => {
    const reactionSnapshot = (
      status: "open" | "submitted",
      deadlineAt: number,
    ) =>
      ({
        ...snapshot,
        view: {
          ...snapshot.view,
          game: {
            ...snapshot.view.game,
            deadlineAt,
            phase: "awaiting-discard-reactions",
            reaction: {
              kind: "discard",
              sourceSeat: "north",
              sourceTile: {
                id: 12,
                kind: { rank: 4, suit: "characters", type: "suited" },
              },
              windowId: "discard:12",
            },
            viewerActions: {
              reaction: {
                actions:
                  status === "open"
                    ? [
                        { type: "pass" },
                        { type: "chow", handTileIds: [4, 8] },
                        { type: "win" },
                      ]
                    : [],
                status,
                windowId: "discard:12",
              },
              self: [],
            },
          },
        },
      }) as unknown as ViewerSafeTableSnapshot;

    const open = renderToStaticMarkup(
      <GamePanel
        connected
        latestReceipt={undefined}
        onCommand={vi.fn()}
        snapshot={reactionSnapshot("open", Date.now() + 10_000)}
      />,
    );
    expect(open).toContain("Pass");
    expect(open).toContain("Chow with tiles 4, 8");
    expect(open).toContain("Declare win");

    const submitted = renderToStaticMarkup(
      <GamePanel
        connected
        latestReceipt={undefined}
        onCommand={vi.fn()}
        snapshot={reactionSnapshot("submitted", Date.now() + 10_000)}
      />,
    );
    expect(submitted).toContain("Response submitted.");
    expect(submitted).not.toContain(">Pass<");

    const expired = renderToStaticMarkup(
      <GamePanel
        connected
        latestReceipt={undefined}
        onCommand={vi.fn()}
        snapshot={reactionSnapshot("open", Date.now() - 1)}
      />,
    );
    expect(expired).toContain("Deadline passed locally");
    expect(expired).toContain('disabled=""');
  });

  it("renders a complete score explanation and a zero-sum payment total", () => {
    const complete = {
      ...snapshot,
      view: {
        ...snapshot.view,
        phase: "complete",
        game: {
          ...snapshot.view.game,
          deadlineAt: null,
          phase: "complete",
          result: {
            awardedPatterns: [
              { category: "hand", faan: 3, id: "all-triplets" },
            ],
            bonusFaan: 1,
            cappedFaan: 4,
            decomposition: {
              encoding: "test",
              kind: "standard",
              melds: [],
              pair: [0, 1],
            },
            detectedPatterns: [
              { category: "hand", faan: 3, id: "all-triplets" },
              { category: "bonus", faan: 1, id: "no-bonuses" },
              { category: "winning-condition", faan: 1, id: "fully-concealed" },
            ],
            eligibilityFaan: 3,
            explanation: {
              awardedPatternIds: ["all-triplets"],
              suppressed: [
                {
                  by: "all-triplets",
                  patternId: "fully-concealed",
                  reason: "specific-condition",
                },
              ],
            },
            isLegalWin: true,
            payments: { east: -8, south: -8, west: 24, north: -8 },
            rawFaan: 4,
            source: { type: "self-pick" },
            suppressedPatterns: [
              {
                by: "all-triplets",
                pattern: {
                  category: "winning-condition",
                  faan: 1,
                  id: "fully-concealed",
                },
                reason: "specific-condition",
              },
            ],
            tablePoints: 16,
            winnerSeat: "west",
            winningConditions: {
              opening: "none",
              replacement: "none",
              wallPosition: "ordinary",
            },
            winningHand: {
              bonusTileIds: [],
              concealedTileIds: [],
              declaredMelds: [],
            },
            winningTileId: 0,
          },
          viewerActions: { self: [] },
        },
      },
    } as unknown as ViewerSafeTableSnapshot;
    const markup = renderToStaticMarkup(
      <GamePanel
        connected
        latestReceipt={undefined}
        onCommand={vi.fn()}
        snapshot={complete}
      />,
    );

    expect(markup).toContain("west wins");
    expect(markup).toContain("all-triplets (+3 faan)");
    expect(markup).toContain("fully-concealed suppressed by all-triplets");
    expect(markup).toContain("Exact seat payments");
    expect(markup).toContain("<dt>Total</dt><dd>+0</dd>");
  });
});
