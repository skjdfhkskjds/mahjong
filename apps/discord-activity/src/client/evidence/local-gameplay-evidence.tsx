import { useState } from "react";
import {
  createScoringHandFixture,
  scoreHongKongHand,
  scoringTileId,
  type CompletedHandResult,
} from "@mahjong/rules-hong-kong";

import {
  parseTableSnapshot,
  type TableCommand,
  type ViewerSafeTableSnapshot,
} from "../adapters/transport/table-socket-status.js";
import { GamePanel } from "../features/gameplay/game-panel.js";

/*
 * This module is loaded only by the DEV + mock + explicit-query branch in
 * bootstrap/main.tsx. Keep it viewer-projection-only: its purpose is to make
 * otherwise shuffle-dependent UI states deterministic for local browser QA.
 */

type Scenario = "claim" | "kong" | "result";

const actors = {
  east: { displayName: "east player", id: "evidence:east" },
  north: { displayName: "north player", id: "evidence:north" },
  south: { displayName: "south player", id: "evidence:south" },
  west: { displayName: "west player", id: "evidence:west" },
} as const;

function suitedTile(
  id: number,
  suit: "bamboo" | "characters" | "circles",
  rank: number,
) {
  return { id, kind: { rank, suit, type: "suited" } } as const;
}

const baseSnapshot = strictSnapshot({
  protocolVersion: 2,
  stateVersion: 24,
  type: "table/snapshot",
  view: {
    game: {
      deadlineAt: Date.now() + 600_000,
      phase: "awaiting-discard-reactions",
      players: [
        {
          bonuses: [],
          concealedCount: 13,
          discards: [],
          melds: [],
          seat: "east",
        },
        {
          bonuses: [],
          concealedCount: 13,
          discards: [suitedTile(52, "circles", 5)],
          melds: [],
          seat: "south",
        },
        {
          bonuses: [],
          concealedCount: 4,
          discards: [],
          melds: [],
          seat: "west",
        },
        {
          bonuses: [],
          concealedCount: 13,
          discards: [],
          melds: [],
          seat: "north",
        },
      ],
      reaction: {
        kind: "discard",
        sourceSeat: "south",
        sourceTile: suitedTile(52, "circles", 5),
        windowId: "evidence:discard:24",
      },
      turn: "south",
      viewerActions: {
        reaction: {
          actions: [
            { type: "pass" },
            { handTileIds: [44, 48], type: "chow" },
            { type: "win" },
          ],
          status: "open",
          windowId: "evidence:discard:24",
        },
        self: [],
      },
      viewerHand: [
        suitedTile(44, "circles", 3),
        suitedTile(48, "circles", 4),
        suitedTile(72, "bamboo", 1),
        suitedTile(76, "bamboo", 2),
      ],
      wallRemaining: 61,
    },
    phase: "playing",
    seats: (["east", "south", "west", "north"] as const).map((seat) => ({
      autopilot: false,
      occupant: actors[seat],
      ready: true,
      seat,
    })),
    spectators: [],
    tableId: "local-viewer-evidence",
    viewer: { actor: actors.west, role: "player", seat: "west" },
  },
});

function strictSnapshot(
  value: ViewerSafeTableSnapshot,
): ViewerSafeTableSnapshot {
  return parseTableSnapshot(value);
}

function gameIn(snapshot: ViewerSafeTableSnapshot) {
  const game = snapshot.view.game;
  if (game === undefined) throw new Error("Local evidence game is missing.");
  return game;
}

function kongSnapshot(): ViewerSafeTableSnapshot {
  const baseGame = gameIn(baseSnapshot);
  return strictSnapshot({
    ...baseSnapshot,
    stateVersion: 25,
    view: {
      ...baseSnapshot.view,
      game: {
        deadlineAt: baseGame.deadlineAt,
        phase: "awaiting-discard",
        players: baseGame.players.map((player) =>
          player.seat === "west"
            ? {
                ...player,
                concealedCount: 5,
                discards: [],
                melds: [
                  {
                    claimedTileId: 52,
                    exposure: "exposed",
                    id: "evidence:meld:circles-5",
                    kind: "pung",
                    sourceSeat: "east",
                    tileIds: [
                      suitedTile(52, "circles", 5),
                      suitedTile(53, "circles", 5),
                      suitedTile(54, "circles", 5),
                    ],
                  },
                ],
              }
            : player.seat === "south"
              ? { ...player, discards: [] }
              : player,
        ),
        turn: "west",
        viewerActions: {
          self: [
            { tileId: 55, type: "game/discard" },
            { tileId: 72, type: "game/discard" },
            { tileId: 73, type: "game/discard" },
            { tileId: 74, type: "game/discard" },
            { tileId: 75, type: "game/discard" },
            { tileIds: [72, 73, 74, 75], type: "game/declare-concealed-kong" },
            {
              meldId: "evidence:meld:circles-5",
              tileId: 55,
              type: "game/propose-added-kong",
            },
            { type: "game/declare-win" },
          ],
        },
        viewerHand: [
          suitedTile(55, "circles", 5),
          suitedTile(72, "bamboo", 1),
          suitedTile(73, "bamboo", 1),
          suitedTile(74, "bamboo", 1),
          suitedTile(75, "bamboo", 1),
        ],
        wallRemaining: baseGame.wallRemaining,
      },
    },
  });
}

function completedResult(): CompletedHandResult {
  const concealedTileIds = [
    scoringTileId({ rank: 1, suit: "characters", type: "suited" }, 0),
    scoringTileId({ rank: 2, suit: "characters", type: "suited" }, 0),
    scoringTileId({ rank: 3, suit: "characters", type: "suited" }, 0),
    scoringTileId({ rank: 4, suit: "characters", type: "suited" }, 0),
    scoringTileId({ rank: 5, suit: "characters", type: "suited" }, 0),
    scoringTileId({ rank: 6, suit: "characters", type: "suited" }, 0),
    scoringTileId({ rank: 1, suit: "circles", type: "suited" }, 0),
    scoringTileId({ rank: 2, suit: "circles", type: "suited" }, 0),
    scoringTileId({ rank: 3, suit: "circles", type: "suited" }, 0),
    scoringTileId({ rank: 7, suit: "bamboo", type: "suited" }, 0),
    scoringTileId({ rank: 8, suit: "bamboo", type: "suited" }, 0),
    scoringTileId({ rank: 9, suit: "bamboo", type: "suited" }, 0),
    scoringTileId({ dragon: "red", type: "dragon" }, 0),
    scoringTileId({ dragon: "red", type: "dragon" }, 1),
  ] as const;
  const fixture = createScoringHandFixture({
    concealedTileIds,
    prevailingWind: "east",
    winnerSeat: "west",
    winningConditions: {
      opening: "none",
      replacement: "none",
      wallPosition: "ordinary",
    },
    winningTileId: concealedTileIds[13],
    winningTileSource: { type: "self-pick" },
  } as unknown as Parameters<typeof createScoringHandFixture>[0]);
  const score = scoreHongKongHand(fixture);
  if (score === null) throw new Error("Local evidence result did not score.");
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

function resultSnapshot(): ViewerSafeTableSnapshot {
  const baseGame = gameIn(baseSnapshot);
  const result = completedResult();
  const viewerHand = [
    suitedTile(0, "characters", 1),
    suitedTile(4, "characters", 2),
    suitedTile(8, "characters", 3),
    suitedTile(12, "characters", 4),
    suitedTile(16, "characters", 5),
    suitedTile(20, "characters", 6),
    suitedTile(36, "circles", 1),
    suitedTile(40, "circles", 2),
    suitedTile(44, "circles", 3),
    suitedTile(96, "bamboo", 7),
    suitedTile(100, "bamboo", 8),
    suitedTile(104, "bamboo", 9),
    { id: 124, kind: { dragon: "red", type: "dragon" } },
    { id: 125, kind: { dragon: "red", type: "dragon" } },
  ] as const;
  return strictSnapshot({
    ...baseSnapshot,
    stateVersion: 26,
    view: {
      ...baseSnapshot.view,
      phase: "complete",
      game: {
        deadlineAt: null,
        phase: "complete",
        players: baseGame.players.map((player) => ({
          ...player,
          concealedCount: player.seat === "west" ? viewerHand.length : 13,
          discards: [],
          melds: [],
        })),
        result,
        turn: "west",
        viewerActions: { self: [] },
        viewerHand,
        wallRemaining: baseGame.wallRemaining,
      },
    },
  });
}

export function LocalGameplayEvidence() {
  const [connected, setConnected] = useState(true);
  const [scenario, setScenario] = useState<Scenario>("claim");
  const [status, setStatus] = useState("Ready for a viewer-safe UI smoke.");
  const snapshot =
    scenario === "claim"
      ? baseSnapshot
      : scenario === "kong"
        ? kongSnapshot()
        : resultSnapshot();

  const onCommand = (command: TableCommand): boolean => {
    if (!connected) return false;
    const commandJson = JSON.stringify({
      command,
      commandId: "local-evidence",
      expectedStateVersion: snapshot.stateVersion,
      protocolVersion: 2,
      type: "table/command",
    });
    setStatus(commandJson);
    if (command.type === "game/declare-win") {
      setScenario("result");
      return true;
    }
    return true;
  };

  const reconnect = () => {
    setConnected(false);
    setStatus("Reconnecting with the same viewer-safe snapshot.");
    window.setTimeout(() => {
      setConnected(true);
      setStatus("Reconnected and resynchronized.");
    }, 400);
  };

  return (
    <div className="app-shell local-evidence-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Development-only evidence</p>
          <h1>Gameplay viewer smoke</h1>
          <p className="hero__copy">
            This mock-only page renders allowlisted protocol-v2 projections. It
            contains no wall, opponent hand, canonical event, hash, or authority
            mutation.
          </p>
        </div>
        <span className="mode-chip">viewer fixture</span>
      </header>
      <nav className="game-actions" aria-label="Evidence scenarios">
        <button
          onClick={() => {
            setScenario("claim");
          }}
        >
          Claim scenario
        </button>
        <button
          onClick={() => {
            setScenario("kong");
          }}
        >
          Kong and win scenario
        </button>
        <button
          onClick={() => {
            setScenario("result");
          }}
        >
          Score result
        </button>
        <button onClick={reconnect}>Reconnect</button>
      </nav>
      <p
        className="privacy-note"
        role="status"
        style={{ overflowWrap: "anywhere" }}
      >
        {status}
      </p>
      <main>
        <GamePanel
          connected={connected}
          latestReceipt={undefined}
          onCommand={onCommand}
          snapshot={snapshot}
        />
      </main>
    </div>
  );
}
