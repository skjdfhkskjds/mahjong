import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScoringHandFixture,
  scoreHongKongHand,
  scoringTileId,
  type CompletedHandResult,
} from "@mahjong/rules-hong-kong";

import {
  createTableSocketUrl,
  parseTableReceipt,
  parseTableSnapshot,
  ReconnectingSocketStatusMonitor,
  type TableCommand,
} from "./table-socket-status.js";

const snapshot = {
  type: "table/snapshot",
  protocolVersion: 2,
  stateVersion: 0,
  view: {
    phase: "lobby",
    seats: [
      { seat: "east", occupant: null, autopilot: false, ready: false },
      { seat: "south", occupant: null, autopilot: false, ready: false },
      { seat: "west", occupant: null, autopilot: false, ready: false },
      { seat: "north", occupant: null, autopilot: false, ready: false },
    ],
    spectators: [{ id: "mock:1", displayName: "Local Player" }],
    tableId: "walking-skeleton",
    viewer: {
      role: "spectator",
      actor: { id: "mock:1", displayName: "Local Player" },
    },
  },
} as const;

function completedResult(): CompletedHandResult {
  const concealedTileIds = [
    scoringTileId({ type: "suited", suit: "characters", rank: 1 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 2 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 3 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 4 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 5 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 6 }, 0),
    scoringTileId({ type: "suited", suit: "circles", rank: 1 }, 0),
    scoringTileId({ type: "suited", suit: "circles", rank: 2 }, 0),
    scoringTileId({ type: "suited", suit: "circles", rank: 3 }, 0),
    scoringTileId({ type: "suited", suit: "bamboo", rank: 7 }, 0),
    scoringTileId({ type: "suited", suit: "bamboo", rank: 8 }, 0),
    scoringTileId({ type: "suited", suit: "bamboo", rank: 9 }, 0),
    scoringTileId({ type: "dragon", dragon: "red" }, 0),
    scoringTileId({ type: "dragon", dragon: "red" }, 1),
  ] as const;
  const winningConditions = {
    opening: "none",
    replacement: "none",
    wallPosition: "ordinary",
  } as const;
  const source = { type: "self-pick" } as const;
  const fixture = createScoringHandFixture({
    concealedTileIds,
    prevailingWind: "east",
    winnerSeat: "west",
    winningConditions,
    winningTileId: concealedTileIds[13],
    winningTileSource: source,
  } as unknown as Parameters<typeof createScoringHandFixture>[0]);
  const score = scoreHongKongHand(fixture);
  if (score === null)
    throw new Error("Completed result fixture did not score.");
  return {
    ...score,
    isLegalWin: true,
    source: fixture.winningTileSource,
    winnerSeat: fixture.winnerSeat,
    winningConditions: fixture.winningConditions,
    winningHand: {
      bonusTileIds: [],
      concealedTileIds,
      declaredMelds: [],
    },
    winningTileId: concealedTileIds[13],
  };
}

function completedMeldResult(): CompletedHandResult {
  const declaredMelds = [
    {
      claimedTileId: scoringTileId(
        { type: "suited", suit: "characters", rank: 1 },
        0,
      ),
      exposure: "exposed",
      id: "meld:terminal:pung",
      kind: "pung",
      sourceSeat: "east",
      tileIds: [0, 1, 2],
    },
  ] as const;
  const concealedTileIds = [
    scoringTileId({ type: "suited", suit: "characters", rank: 2 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 2 }, 1),
    scoringTileId({ type: "suited", suit: "characters", rank: 2 }, 2),
    scoringTileId({ type: "suited", suit: "characters", rank: 3 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 3 }, 1),
    scoringTileId({ type: "suited", suit: "characters", rank: 3 }, 2),
    scoringTileId({ type: "suited", suit: "characters", rank: 4 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 4 }, 1),
    scoringTileId({ type: "suited", suit: "characters", rank: 4 }, 2),
    scoringTileId({ type: "dragon", dragon: "red" }, 0),
    scoringTileId({ type: "dragon", dragon: "red" }, 1),
  ] as const;
  const fixture = createScoringHandFixture({
    concealedTileIds,
    declaredMelds,
    prevailingWind: "east",
    winnerSeat: "west",
    winningConditions: {
      opening: "none",
      replacement: "none",
      wallPosition: "ordinary",
    },
    winningTileId: concealedTileIds[10],
    winningTileSource: { type: "self-pick" },
  } as unknown as Parameters<typeof createScoringHandFixture>[0]);
  const score = scoreHongKongHand(fixture);
  if (score === null) throw new Error("Declared-meld fixture did not score.");
  return {
    ...score,
    isLegalWin: true,
    source: fixture.winningTileSource,
    winnerSeat: fixture.winnerSeat,
    winningConditions: fixture.winningConditions,
    winningHand: {
      bonusTileIds: [],
      concealedTileIds: fixture.concealedTileIds,
      declaredMelds: fixture.declaredMelds,
    },
    winningTileId: fixture.winningTileId,
  };
}

function completedConcealedKongResult(): CompletedHandResult {
  const concealedTileIds = [
    scoringTileId({ type: "suited", suit: "characters", rank: 2 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 2 }, 1),
    scoringTileId({ type: "suited", suit: "characters", rank: 2 }, 2),
    scoringTileId({ type: "suited", suit: "characters", rank: 3 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 3 }, 1),
    scoringTileId({ type: "suited", suit: "characters", rank: 3 }, 2),
    scoringTileId({ type: "suited", suit: "characters", rank: 4 }, 0),
    scoringTileId({ type: "suited", suit: "characters", rank: 4 }, 1),
    scoringTileId({ type: "suited", suit: "characters", rank: 4 }, 2),
    scoringTileId({ type: "dragon", dragon: "red" }, 0),
    scoringTileId({ type: "dragon", dragon: "red" }, 1),
  ] as const;
  const declaredMelds = [
    {
      exposure: "concealed",
      id: "meld:terminal:kong",
      kind: "kong",
      kongKind: "concealed",
      tileIds: [0, 1, 2, 3],
    },
  ] as const;
  const fixture = createScoringHandFixture({
    concealedTileIds,
    declaredMelds,
    prevailingWind: "east",
    winnerSeat: "west",
    winningConditions: {
      opening: "none",
      replacement: "none",
      wallPosition: "ordinary",
    },
    winningTileId: concealedTileIds[10],
    winningTileSource: { type: "self-pick" },
  } as unknown as Parameters<typeof createScoringHandFixture>[0]);
  const score = scoreHongKongHand(fixture);
  if (score === null) throw new Error("Concealed-kong fixture did not score.");
  return {
    ...score,
    isLegalWin: true,
    source: fixture.winningTileSource,
    winnerSeat: fixture.winnerSeat,
    winningConditions: fixture.winningConditions,
    winningHand: {
      bonusTileIds: [],
      concealedTileIds: fixture.concealedTileIds,
      declaredMelds: fixture.declaredMelds,
    },
    winningTileId: fixture.winningTileId,
  };
}

function projectedTile(id: number) {
  if (id < 108) {
    const suits = ["characters", "circles", "bamboo"] as const;
    return {
      id,
      kind: {
        rank: Math.floor((id % 36) / 4) + 1,
        suit: suits[Math.floor(id / 36)],
        type: "suited",
      },
    } as const;
  }
  if (id < 124) {
    const winds = ["east", "south", "west", "north"] as const;
    return {
      id,
      kind: { type: "wind", wind: winds[Math.floor((id - 108) / 4)] },
    } as const;
  }
  if (id < 136) {
    const dragons = ["red", "green", "white"] as const;
    return {
      id,
      kind: { dragon: dragons[Math.floor((id - 124) / 4)], type: "dragon" },
    } as const;
  }
  throw new Error(
    "The terminal projection fixture uses structural tiles only.",
  );
}

class FakeSocket {
  public closed = false;
  public closeCode: number | undefined;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  public addEventListener(
    type: string,
    listener: (event: Event) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }

  public send(value: string): void {
    this.sent.push(value);
  }

  public emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("viewer-safe table snapshots", () => {
  it("builds a server-resolved table socket URL without a table locator", () => {
    expect(
      createTableSocketUrl("", { origin: "https://activity.example" }),
    ).toBe("wss://activity.example/api/table/socket?protocolVersion=2");
  });

  it("parses the walking-skeleton lobby projection", () => {
    expect(parseTableSnapshot(snapshot)).toEqual({
      type: "table/snapshot",
      protocolVersion: 2,
      stateVersion: 0,
      view: {
        phase: "lobby",
        tableId: "walking-skeleton",
        seats: [
          { seat: "east", occupant: null, autopilot: false, ready: false },
          { seat: "south", occupant: null, autopilot: false, ready: false },
          { seat: "west", occupant: null, autopilot: false, ready: false },
          { seat: "north", occupant: null, autopilot: false, ready: false },
        ],
        spectators: [{ id: "mock:1", displayName: "Local Player" }],
        viewer: {
          role: "spectator",
          actor: { id: "mock:1", displayName: "Local Player" },
        },
      },
    });
  });

  it("rejects a projection without a viewer identity", () => {
    expect(() =>
      parseTableSnapshot({
        type: "table/snapshot",
        protocolVersion: 2,
        stateVersion: 0,
        view: {
          phase: "lobby",
          tableId: "walking-skeleton",
          seats: snapshot.view.seats,
          spectators: snapshot.view.spectators,
        },
      }),
    ).toThrow("view");
  });

  it("rejects an unsupported protocol version", () => {
    expect(() =>
      parseTableSnapshot({ ...snapshot, protocolVersion: 1 }),
    ).toThrow("protocol v2");
  });

  it("parses a player projection when the viewer matches the occupied seat", () => {
    const actor = { id: "mock:2", displayName: "East Player" };
    expect(
      parseTableSnapshot({
        ...snapshot,
        stateVersion: 4,
        view: {
          ...snapshot.view,
          seats: [
            { seat: "east", occupant: actor, autopilot: false, ready: true },
            ...snapshot.view.seats.slice(1),
          ],
          spectators: snapshot.view.spectators,
          viewer: { actor, role: "player", seat: "east" },
        },
      }).view.viewer,
    ).toEqual({ actor, role: "player", seat: "east" });
  });

  it("strictly parses a private gameplay projection", () => {
    const actors = [
      { id: "mock:east", displayName: "East Player" },
      { id: "mock:south", displayName: "South Player" },
      { id: "mock:west", displayName: "West Player" },
      { id: "mock:north", displayName: "North Player" },
    ] as const;
    const gameSnapshot = {
      ...snapshot,
      stateVersion: 12,
      view: {
        ...snapshot.view,
        phase: "playing",
        game: {
          deadlineAt: Date.now() + 60_000,
          phase: "awaiting-dealer-discard",
          players: ["east", "south", "west", "north"].map((seat, index) => ({
            bonuses: [],
            concealedCount: index === 0 ? 2 : 13,
            discards: [],
            melds: [],
            seat,
          })),
          turn: "east",
          viewerActions: {
            self: [
              { type: "game/discard", tileId: 0 },
              { type: "game/discard", tileId: 8 },
            ],
          },
          viewerHand: [
            {
              id: 0,
              kind: { type: "suited", suit: "characters", rank: 1 },
            },
            {
              id: 8,
              kind: { type: "suited", suit: "characters", rank: 3 },
            },
          ],
          wallRemaining: 87,
        },
        seats: ["east", "south", "west", "north"].map((seat, index) => ({
          seat,
          occupant: actors[index],
          autopilot: false,
          ready: true,
        })),
        spectators: [],
        viewer: { actor: actors[0], role: "player", seat: "east" },
      },
    };
    const parsedGame = parseTableSnapshot(gameSnapshot).view.game;
    expect(parsedGame).toMatchObject({
      phase: "awaiting-dealer-discard",
      turn: "east",
      wallRemaining: 87,
    });
    expect(parsedGame?.viewerHand?.map(({ id }) => id)).toEqual([0, 8]);
    const reactionSnapshot = {
      ...gameSnapshot,
      view: {
        ...gameSnapshot.view,
        game: {
          ...gameSnapshot.view.game,
          phase: "awaiting-discard-reactions",
          players: gameSnapshot.view.game.players.map((player) =>
            player.seat === "north"
              ? {
                  ...player,
                  discards: [
                    {
                      id: 4,
                      kind: {
                        type: "suited",
                        suit: "characters",
                        rank: 2,
                      },
                    },
                  ],
                }
              : player,
          ),
          reaction: {
            kind: "discard",
            sourceSeat: "north",
            sourceTile: {
              id: 4,
              kind: { type: "suited", suit: "characters", rank: 2 },
            },
            windowId: "discard:12",
          },
          viewerActions: {
            reaction: {
              actions: [
                { type: "pass" },
                { type: "chow", handTileIds: [0, 8] },
              ],
              status: "open",
              windowId: "discard:12",
            },
            self: [],
          },
        },
      },
    };
    expect(
      parseTableSnapshot(reactionSnapshot).view.game?.viewerActions,
    ).toMatchObject({ reaction: { status: "open" }, self: [] });
    expect(() =>
      parseTableSnapshot({
        ...reactionSnapshot,
        view: {
          ...reactionSnapshot.view,
          game: {
            ...reactionSnapshot.view.game,
            wall: { order: [1, 2, 3] },
          },
        },
      }),
    ).toThrow("game view");
    expect(() =>
      parseTableSnapshot({
        ...reactionSnapshot,
        view: {
          ...reactionSnapshot.view,
          game: {
            ...reactionSnapshot.view.game,
            viewerActions: {
              reaction: {
                actions: [{ type: "win" }],
                status: "submitted",
                windowId: "discard:12",
              },
              self: [],
            },
          },
        },
      }),
    ).toThrow("incoherent private reaction");
    expect(() =>
      parseTableSnapshot({
        ...reactionSnapshot,
        view: {
          ...reactionSnapshot.view,
          game: {
            ...reactionSnapshot.view.game,
            players: reactionSnapshot.view.game.players.map((player) => ({
              ...player,
              discards:
                player.seat === "south"
                  ? [reactionSnapshot.view.game.reaction.sourceTile]
                  : [],
            })),
            reaction: {
              ...reactionSnapshot.view.game.reaction,
              sourceSeat: "south",
            },
          },
        },
      }),
    ).toThrow("impossible for its source tile");
    const addedReactionSnapshot = {
      ...reactionSnapshot,
      view: {
        ...reactionSnapshot.view,
        game: {
          ...reactionSnapshot.view.game,
          phase: "awaiting-added-kong-reactions",
          players: reactionSnapshot.view.game.players.map((player) =>
            player.seat === "north"
              ? {
                  ...player,
                  discards: [],
                  melds: [
                    {
                      claimedTileId: 4,
                      exposure: "exposed",
                      id: "meld:north:pung",
                      kind: "pung",
                      sourceSeat: "west",
                      tileIds: [4, 5, 6].map((id) => ({
                        id,
                        kind: {
                          type: "suited",
                          suit: "characters",
                          rank: 2,
                        },
                      })),
                    },
                  ],
                }
              : player,
          ),
          reaction: {
            kind: "added-kong",
            sourceMeldId: "meld:north:pung",
            sourceSeat: "north",
            sourceTile: {
              id: 7,
              kind: { type: "suited", suit: "characters", rank: 2 },
            },
            windowId: "added-kong:12",
          },
          viewerActions: {
            reaction: {
              actions: [
                { type: "pass" },
                { type: "chow", handTileIds: [0, 8] },
              ],
              status: "open",
              windowId: "added-kong:12",
            },
            self: [],
          },
        },
      },
    };
    expect(() => parseTableSnapshot(addedReactionSnapshot)).toThrow(
      "added-kong window",
    );
    expect(() =>
      parseTableSnapshot({
        ...addedReactionSnapshot,
        view: {
          ...addedReactionSnapshot.view,
          game: {
            ...addedReactionSnapshot.view.game,
            players: addedReactionSnapshot.view.game.players.map((player) =>
              player.seat === "east"
                ? { ...player, concealedCount: 3 }
                : player,
            ),
            viewerActions: {
              reaction: {
                actions: [{ type: "pass" }],
                status: "open",
                windowId: "added-kong:12",
              },
              self: [],
            },
            viewerHand: [
              ...addedReactionSnapshot.view.game.viewerHand,
              {
                id: 7,
                kind: { type: "suited", suit: "characters", rank: 2 },
              },
            ].sort((left, right) => left.id - right.id),
          },
        },
      }),
    ).toThrow("repeats visible tile ownership");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: {
            ...gameSnapshot.view.game,
            viewerActions: {
              self: [
                { type: "game/discard", tileId: 0 },
                { type: "game/discard", tileId: 8 },
                {
                  type: "game/declare-concealed-kong",
                  tileIds: [0, 4, 8, 12],
                },
              ],
            },
          },
        },
      }),
    ).toThrow("impossible concealed kong");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: {
            ...gameSnapshot.view.game,
            players: gameSnapshot.view.game.players.map((player) =>
              player.seat === "east"
                ? { ...player, concealedCount: 3 }
                : player.seat === "south"
                  ? {
                      ...player,
                      melds: [
                        {
                          claimedTileId: 4,
                          exposure: "exposed",
                          id: "meld:south:pung",
                          kind: "pung",
                          sourceSeat: "west",
                          tileIds: [4, 5, 6].map((id) => ({
                            id,
                            kind: {
                              type: "suited",
                              suit: "characters",
                              rank: 2,
                            },
                          })),
                        },
                      ],
                    }
                  : player,
            ),
            viewerActions: {
              self: [
                { type: "game/discard", tileId: 0 },
                { type: "game/discard", tileId: 7 },
                { type: "game/discard", tileId: 8 },
                {
                  type: "game/propose-added-kong",
                  meldId: "meld:south:pung",
                  tileId: 7,
                },
              ],
            },
            viewerHand: [
              ...gameSnapshot.view.game.viewerHand,
              {
                id: 7,
                kind: { type: "suited", suit: "characters", rank: 2 },
              },
            ].sort((left, right) => left.id - right.id),
          },
        },
      }),
    ).toThrow("hidden state");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: {
            ...gameSnapshot.view.game,
            players: gameSnapshot.view.game.players.map((player) =>
              player.seat === "east"
                ? {
                    ...player,
                    concealedCount: 3,
                    melds: [
                      {
                        claimedTileId: 4,
                        exposure: "exposed",
                        id: "meld:east:pung",
                        kind: "pung",
                        sourceSeat: "south",
                        tileIds: [4, 5, 6].map((id) => ({
                          id,
                          kind: {
                            type: "suited",
                            suit: "characters",
                            rank: 2,
                          },
                        })),
                      },
                    ],
                  }
                : player,
            ),
            viewerActions: {
              self: [
                { type: "game/discard", tileId: 0 },
                { type: "game/discard", tileId: 7 },
                { type: "game/discard", tileId: 8 },
                {
                  type: "game/propose-added-kong",
                  meldId: "meld:east:pung",
                  tileId: 0,
                },
              ],
            },
            viewerHand: [
              ...gameSnapshot.view.game.viewerHand,
              {
                id: 7,
                kind: { type: "suited", suit: "characters", rank: 2 },
              },
            ].sort((left, right) => left.id - right.id),
          },
        },
      }),
    ).toThrow("hidden state");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          phase: "complete",
          game: {
            ...gameSnapshot.view.game,
            deadlineAt: null,
            phase: "complete",
            result: { canonicalState: { wall: [1, 2, 3] } },
            viewerActions: { self: [] },
          },
        },
      }),
    ).toThrow("Completed hand result");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: {
            ...gameSnapshot.view.game,
            players: gameSnapshot.view.game.players.map((player) =>
              player.seat === "south"
                ? {
                    ...player,
                    melds: [
                      {
                        claimedTileId: 0,
                        exposure: "exposed",
                        id: "meld:duplicate",
                        kind: "pung",
                        sourceSeat: "west",
                        tileIds: [0, 1, 2].map((id) => ({
                          id,
                          kind: {
                            type: "suited",
                            suit: "characters",
                            rank: 1,
                          },
                        })),
                      },
                    ],
                  }
                : player,
            ),
          },
        },
      }),
    ).toThrow("repeats a visible physical tile ID");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: { ...gameSnapshot.view.game, wall: { order: [1, 2, 3] } },
        },
      }),
    ).toThrow("game view");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: {
            ...gameSnapshot.view.game,
            viewerHand: [
              {
                id: 0,
                kind: {
                  type: "suited",
                  suit: "characters",
                  rank: 1,
                  canonicalCopy: 0,
                },
              },
            ],
          },
        },
      }),
    ).toThrow("public tile");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: {
          ...gameSnapshot.view,
          game: {
            ...gameSnapshot.view.game,
            viewerHand: [
              {
                id: 0,
                kind: { type: "suited", suit: "characters", rank: 2 },
              },
            ],
          },
        },
      }),
    ).toThrow("does not match");
    const spectator = { id: "mock:viewer", displayName: "Spectator" };
    const spectatorSnapshot = {
      ...gameSnapshot,
      view: {
        ...gameSnapshot.view,
        game: {
          ...gameSnapshot.view.game,
          viewerActions: undefined,
          viewerHand: undefined,
        },
        spectators: [spectator],
        viewer: { actor: spectator, role: "spectator" },
      },
    };
    expect(parseTableSnapshot(spectatorSnapshot).view.game).not.toHaveProperty(
      "viewerHand",
    );
    const completeSnapshot = {
      ...spectatorSnapshot,
      view: {
        ...spectatorSnapshot.view,
        phase: "complete",
        game: {
          ...spectatorSnapshot.view.game,
          deadlineAt: null,
          phase: "complete",
          players: spectatorSnapshot.view.game.players.map((player) =>
            player.seat === "west" ? { ...player, concealedCount: 14 } : player,
          ),
          result: completedResult(),
          viewerActions: undefined,
          viewerHand: undefined,
        },
      },
    };
    expect(
      parseTableSnapshot(completeSnapshot).view.game?.result,
    ).toMatchObject({
      cappedFaan: 4,
      payments: { east: -8, north: -8, south: -8, west: 24 },
      winnerSeat: "west",
    });
    expect(() =>
      parseTableSnapshot({
        ...spectatorSnapshot,
        view: {
          ...spectatorSnapshot.view,
          game: {
            ...spectatorSnapshot.view.game,
            viewerHand: gameSnapshot.view.game.viewerHand,
          },
        },
      }),
    ).toThrow("private data");
    expect(() =>
      parseTableSnapshot({
        ...gameSnapshot,
        view: { ...gameSnapshot.view, phase: "exhausted" },
      }),
    ).toThrow("phase");
  });

  it("cross-checks terminal results against the public winner projection", () => {
    const seats = ["east", "south", "west", "north"] as const;
    const actors = seats.map((seat) => ({
      displayName: `${seat} player`,
      id: `mock:${seat}`,
    }));
    const result = completedResult();
    const viewerHand = result.winningHand.concealedTileIds.map((id) =>
      projectedTile(id),
    );
    const completeSnapshot = {
      protocolVersion: 2,
      stateVersion: 20,
      type: "table/snapshot",
      view: {
        game: {
          deadlineAt: null,
          phase: "complete",
          players: seats.map((seat) => ({
            bonuses: [],
            concealedCount: seat === "west" ? viewerHand.length : 13,
            discards: [],
            melds: [],
            seat,
          })),
          result,
          turn: "west",
          viewerActions: { self: [] },
          viewerHand,
          wallRemaining: 40,
        },
        phase: "complete",
        seats: seats.map((seat, index) => ({
          autopilot: false,
          occupant: actors[index],
          ready: true,
          seat,
        })),
        spectators: [],
        tableId: "terminal-projection",
        viewer: { actor: actors[2], role: "player", seat: "west" },
      },
    } as const;

    expect(parseTableSnapshot(completeSnapshot).view.game?.result).toEqual(
      result,
    );

    const spectator = { displayName: "Spectator", id: "mock:spectator" };
    expect(
      parseTableSnapshot({
        ...completeSnapshot,
        view: {
          ...completeSnapshot.view,
          game: {
            ...completeSnapshot.view.game,
            viewerActions: undefined,
            viewerHand: undefined,
          },
          spectators: [spectator],
          viewer: { actor: spectator, role: "spectator" },
        },
      }).view.game?.result,
    ).toEqual(result);

    const mismatchedWinner = (changes: Record<string, unknown>) => ({
      ...completeSnapshot,
      view: {
        ...completeSnapshot.view,
        game: {
          ...completeSnapshot.view.game,
          players: completeSnapshot.view.game.players.map((player) =>
            player.seat === "west" ? { ...player, ...changes } : player,
          ),
        },
      },
    });
    expect(() =>
      parseTableSnapshot(mismatchedWinner({ concealedCount: 13 })),
    ).toThrow("public winner projection");
    expect(() =>
      parseTableSnapshot(
        mismatchedWinner({
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
        }),
      ),
    ).toThrow("public winner projection");
    expect(() =>
      parseTableSnapshot(
        mismatchedWinner({
          melds: [
            {
              claimedTileId: 56,
              exposure: "exposed",
              id: "meld:forged",
              kind: "pung",
              sourceSeat: "east",
              tileIds: [56, 57, 58].map(projectedTile),
            },
          ],
        }),
      ),
    ).toThrow("public winner projection");
    expect(() =>
      parseTableSnapshot({
        ...completeSnapshot,
        view: {
          ...completeSnapshot.view,
          game: {
            ...completeSnapshot.view.game,
            viewerHand: [...viewerHand.slice(0, -1), projectedTile(126)],
          },
        },
      }),
    ).toThrow("public winner projection");

    const meldResult = completedMeldResult();
    const scoredMeld = meldResult.winningHand.declaredMelds[0];
    if (scoredMeld === undefined)
      throw new Error("Terminal meld fixture is missing its declared pung.");
    const publicMeld = {
      claimedTileId: scoredMeld.claimedTileId,
      exposure: scoredMeld.exposure,
      id: scoredMeld.id,
      kind: scoredMeld.kind,
      sourceSeat: scoredMeld.sourceSeat,
      tileIds: scoredMeld.tileIds.map(projectedTile),
    } as const;
    const meldViewerHand = meldResult.winningHand.concealedTileIds.map((id) =>
      projectedTile(id),
    );
    const meldSnapshot = {
      ...completeSnapshot,
      view: {
        ...completeSnapshot.view,
        game: {
          ...completeSnapshot.view.game,
          players: completeSnapshot.view.game.players.map((player) =>
            player.seat === "west"
              ? {
                  ...player,
                  concealedCount: meldViewerHand.length,
                  melds: [publicMeld],
                }
              : player,
          ),
          result: meldResult,
          viewerHand: meldViewerHand,
        },
      },
    } as const;
    expect(parseTableSnapshot(meldSnapshot).view.game?.result).toEqual(
      meldResult,
    );

    const withPublicMeld = (meld: unknown) => ({
      ...meldSnapshot,
      view: {
        ...meldSnapshot.view,
        game: {
          ...meldSnapshot.view.game,
          players: meldSnapshot.view.game.players.map((player) =>
            player.seat === "west" ? { ...player, melds: [meld] } : player,
          ),
        },
      },
    });
    for (const forgedMeld of [
      { ...publicMeld, id: "meld:other" },
      { ...publicMeld, claimedTileId: 1 },
      { ...publicMeld, sourceSeat: "north" },
      {
        ...publicMeld,
        kind: "kong",
        kongKind: "exposed",
        tileIds: [...publicMeld.tileIds, projectedTile(3)],
      },
      {
        ...publicMeld,
        claimedTileId: 1,
        tileIds: [1, 2, 3].map(projectedTile),
      },
    ]) {
      expect(() => parseTableSnapshot(withPublicMeld(forgedMeld))).toThrow(
        "public winner projection",
      );
    }

    const concealedKongResult = completedConcealedKongResult();
    const scoredKong = concealedKongResult.winningHand.declaredMelds[0];
    if (scoredKong === undefined)
      throw new Error("Terminal kong fixture is missing its declared kong.");
    const publicKong = {
      exposure: scoredKong.exposure,
      id: scoredKong.id,
      kind: scoredKong.kind,
      kongKind: scoredKong.kongKind,
      tileIds: scoredKong.tileIds.map(projectedTile),
    } as const;
    const kongViewerHand =
      concealedKongResult.winningHand.concealedTileIds.map(projectedTile);
    const kongSnapshot = {
      ...completeSnapshot,
      view: {
        ...completeSnapshot.view,
        game: {
          ...completeSnapshot.view.game,
          players: completeSnapshot.view.game.players.map((player) =>
            player.seat === "west"
              ? {
                  ...player,
                  concealedCount: kongViewerHand.length,
                  melds: [publicKong],
                }
              : player,
          ),
          result: concealedKongResult,
          viewerHand: kongViewerHand,
        },
      },
    } as const;
    expect(parseTableSnapshot(kongSnapshot).view.game?.result).toEqual(
      concealedKongResult,
    );
    expect(() =>
      parseTableSnapshot({
        ...kongSnapshot,
        view: {
          ...kongSnapshot.view,
          game: {
            ...kongSnapshot.view.game,
            players: kongSnapshot.view.game.players.map((player) =>
              player.seat === "west"
                ? {
                    ...player,
                    melds: [
                      {
                        ...publicKong,
                        claimedTileId: 0,
                        exposure: "exposed",
                        kongKind: "exposed",
                        sourceSeat: "east",
                      },
                    ],
                  }
                : player,
            ),
          },
        },
      }),
    ).toThrow("public winner projection");
  });

  it.each([
    ["hidden root field", { ...snapshot, hand: { tiles: [] } }],
    [
      "hidden occupant field",
      {
        ...snapshot,
        view: {
          ...snapshot.view,
          seats: [
            {
              seat: "east",
              occupant: {
                id: "mock:2",
                displayName: "East Player",
                concealedTiles: ["1m"],
              },
              ready: false,
            },
            ...snapshot.view.seats.slice(1),
          ],
        },
      },
    ],
    [
      "non-canonical seat order",
      {
        ...snapshot,
        view: {
          ...snapshot.view,
          seats: [
            snapshot.view.seats[1],
            snapshot.view.seats[0],
            ...snapshot.view.seats.slice(2),
          ],
        },
      },
    ],
    [
      "duplicate actor",
      {
        ...snapshot,
        view: {
          ...snapshot.view,
          spectators: [
            ...snapshot.view.spectators,
            snapshot.view.spectators[0],
          ],
        },
      },
    ],
  ])("rejects a projection with %s", (_name, value) => {
    expect(() => parseTableSnapshot(value)).toThrow();
  });

  it("rejects a spectator viewer carrying a seat", () => {
    expect(() =>
      parseTableSnapshot({
        ...snapshot,
        view: {
          ...snapshot.view,
          viewer: { ...snapshot.view.viewer, seat: "east" },
        },
      }),
    ).toThrow("viewer");
  });

  it("parses applied and rejected command receipts", () => {
    expect(
      parseTableReceipt({
        type: "table/receipt",
        protocolVersion: 2,
        commandId: "command-1",
        stateVersion: 2,
        outcome: "applied",
      }),
    ).toMatchObject({ commandId: "command-1", outcome: "applied" });
    expect(
      parseTableReceipt({
        type: "table/receipt",
        protocolVersion: 2,
        commandId: "command-2",
        stateVersion: 2,
        outcome: "rejected",
        error: { code: "stale-version", message: "Resync required." },
      }),
    ).toMatchObject({
      commandId: "command-2",
      outcome: "rejected",
      error: { code: "stale-version", message: "Resync required." },
    });
  });

  it("rejects non-canonical receipts", () => {
    expect(() =>
      parseTableReceipt({
        type: "table/receipt",
        protocolVersion: 2,
        commandId: "command-1",
        stateVersion: 2,
        outcome: "applied",
        error: { code: "impossible", message: "not allowed" },
      }),
    ).toThrow("outcome");
  });

  it("serializes strict lobby command envelopes", () => {
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      () => socket as unknown as WebSocket,
    );
    monitor.start(() => undefined);
    socket.emit("open", new Event("open"));

    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "claim-1",
      expectedStateVersion: 0,
      command: { type: "lobby/claim-seat", seat: "east" },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "ready-1",
      expectedStateVersion: 1,
      command: { type: "lobby/set-ready", ready: true },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "leave-1",
      expectedStateVersion: 2,
      command: { type: "lobby/leave-seat" },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "discard-1",
      expectedStateVersion: 3,
      command: { type: "game/discard", tileId: 42 },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "reaction-1",
      expectedStateVersion: 4,
      command: {
        type: "game/react",
        windowId: "discard:4",
        response: { type: "pung", handTileIds: [40, 41] },
      },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "concealed-kong-1",
      expectedStateVersion: 5,
      command: {
        type: "game/declare-concealed-kong",
        tileIds: [40, 41, 42, 43],
      },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "added-kong-1",
      expectedStateVersion: 6,
      command: {
        type: "game/propose-added-kong",
        meldId: "meld:1",
        tileId: 43,
      },
    });
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "win-1",
      expectedStateVersion: 7,
      command: { type: "game/declare-win" },
    });

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "claim-1",
        expectedStateVersion: 0,
        command: { type: "lobby/claim-seat", seat: "east" },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "ready-1",
        expectedStateVersion: 1,
        command: { type: "lobby/set-ready", ready: true },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "leave-1",
        expectedStateVersion: 2,
        command: { type: "lobby/leave-seat" },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "discard-1",
        expectedStateVersion: 3,
        command: { type: "game/discard", tileId: 42 },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "reaction-1",
        expectedStateVersion: 4,
        command: {
          type: "game/react",
          windowId: "discard:4",
          response: { type: "pung", handTileIds: [40, 41] },
        },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "concealed-kong-1",
        expectedStateVersion: 5,
        command: {
          type: "game/declare-concealed-kong",
          tileIds: [40, 41, 42, 43],
        },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "added-kong-1",
        expectedStateVersion: 6,
        command: {
          type: "game/propose-added-kong",
          meldId: "meld:1",
          tileId: 43,
        },
      }),
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "win-1",
        expectedStateVersion: 7,
        command: { type: "game/declare-win" },
      }),
    ]);
  });

  it("publishes receipts without treating them as protocol errors", () => {
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const statuses: Parameters<
      Parameters<ReconnectingSocketStatusMonitor["start"]>[0]
    >[0][] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      () => socket as unknown as WebSocket,
    );
    monitor.start((status) => statuses.push(status));
    socket.emit("open", new Event("open"));
    socket.emit(
      "message",
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "table/receipt",
          protocolVersion: 2,
          commandId: "command-1",
          stateVersion: 1,
          outcome: "applied",
        }),
      }),
    );

    expect(statuses.at(-1)).toMatchObject({
      state: "connected",
      latestReceipt: { commandId: "command-1", outcome: "applied" },
    });
    expect(socket.closed).toBe(false);
  });

  it("serializes start, draw, and every reaction response exactly", () => {
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      () => socket as unknown as WebSocket,
    );
    monitor.start(() => undefined);
    socket.emit("open", new Event("open"));
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
    ] as const satisfies readonly TableCommand[];

    commands.forEach((command, index) => {
      monitor.sendCommand({
        type: "table/command",
        protocolVersion: 2,
        commandId: `command-${String(index)}`,
        expectedStateVersion: 12,
        command,
      });
    });

    expect(socket.sent).toEqual(
      commands.map((command, index) =>
        JSON.stringify({
          type: "table/command",
          protocolVersion: 2,
          commandId: `command-${String(index)}`,
          expectedStateVersion: 12,
          command,
        }),
      ),
    );
  });

  it("requests a resync from the last snapshot after reconnecting", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      () => sockets.shift() as unknown as WebSocket,
    );
    const stop = monitor.start((status) => states.push(status.state));

    first.emit("open", new Event("open"));
    first.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(snapshot) }),
    );
    first.emit("close", new Event("close"));
    vi.advanceTimersByTime(1_000);
    second.emit("open", new Event("open"));

    expect(second.sent).toEqual([
      JSON.stringify({
        type: "table/resync",
        protocolVersion: 2,
        lastSeenStateVersion: 0,
      }),
    ]);
    expect(states.at(-1)).toBe("reconnecting");
    expect(() => {
      monitor.sendCommand({
        type: "table/command",
        protocolVersion: 2,
        commandId: "stale-ui-command",
        expectedStateVersion: 0,
        command: { type: "lobby/leave-seat" },
      });
    }).toThrow("not connected");

    second.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(snapshot) }),
    );
    expect(states.at(-1)).toBe("connected");
    stop();
  });

  it("ignores every late callback from a superseded socket generation", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const createSocket = vi.fn(() => sockets.shift() as unknown as WebSocket);
    const statuses: Parameters<
      Parameters<ReconnectingSocketStatusMonitor["start"]>[0]
    >[0][] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      createSocket,
    );
    const stop = monitor.start((status) => statuses.push(status));

    first.emit("open", new Event("open"));
    first.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(snapshot) }),
    );
    first.emit("close", Object.assign(new Event("close"), { code: 1006 }));
    vi.advanceTimersByTime(1_000);
    second.emit("open", new Event("open"));
    const newerSnapshot = { ...snapshot, stateVersion: 7 };
    second.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(newerSnapshot) }),
    );

    first.emit("open", new Event("open"));
    first.emit(
      "message",
      new MessageEvent("message", {
        data: JSON.stringify({ ...snapshot, stateVersion: 99 }),
      }),
    );
    first.emit("error", new Event("error"));
    first.emit("close", Object.assign(new Event("close"), { code: 1008 }));
    vi.advanceTimersByTime(30_000);

    expect(statuses.at(-1)).toMatchObject({
      state: "connected",
      snapshot: { stateVersion: 7 },
    });
    expect(createSocket).toHaveBeenCalledTimes(2);
    monitor.sendCommand({
      type: "table/command",
      protocolVersion: 2,
      commandId: "new-generation-command",
      expectedStateVersion: 7,
      command: { type: "lobby/leave-seat" },
    });
    expect(second.sent.at(-1)).toBe(
      JSON.stringify({
        type: "table/command",
        protocolVersion: 2,
        commandId: "new-generation-command",
        expectedStateVersion: 7,
        command: { type: "lobby/leave-seat" },
      }),
    );
    stop();
  });

  it("treats the session-replaced control frame as terminal", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      createSocket,
    );
    monitor.start((status) => states.push(status.state));

    socket.emit("open", new Event("open"));
    socket.emit(
      "message",
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "session/replaced",
          protocolVersion: 2,
        }),
      }),
    );
    socket.emit("close", Object.assign(new Event("close"), { code: 4001 }));
    vi.advanceTimersByTime(30_000);

    expect(states.at(-1)).toBe("session-replaced");
    expect(socket.closeCode).toBe(4001);
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it("treats the protocol upgrade control frame as terminal", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      createSocket,
    );
    monitor.start((status) => states.push(status.state));

    socket.emit("open", new Event("open"));
    socket.emit(
      "message",
      new MessageEvent("message", {
        data: JSON.stringify({
          minimumSupportedVersion: 2,
          protocolVersion: 2,
          type: "table/upgrade-required",
        }),
      }),
    );
    vi.advanceTimersByTime(30_000);

    expect(states.at(-1)).toBe("upgrade-required");
    expect(socket.closeCode).toBe(4406);
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after a replacement close without a control frame", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      createSocket,
    );
    monitor.start((status) => states.push(status.state));

    socket.emit("open", new Event("open"));
    socket.emit("close", Object.assign(new Event("close"), { code: 4001 }));
    vi.advanceTimersByTime(30_000);

    expect(states.at(-1)).toBe("session-replaced");
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after an authorization policy close", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const socket = new FakeSocket();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const states: string[] = [];
    const monitor = new ReconnectingSocketStatusMonitor(
      "ws://activity.test/api/table/socket?protocolVersion=2",
      createSocket,
    );
    monitor.start((status) => states.push(status.state));

    socket.emit("open", new Event("open"));
    socket.emit("close", Object.assign(new Event("close"), { code: 1008 }));
    vi.advanceTimersByTime(30_000);

    expect(states.at(-1)).toBe("authentication-required");
    expect(createSocket).toHaveBeenCalledTimes(1);
  });
});
