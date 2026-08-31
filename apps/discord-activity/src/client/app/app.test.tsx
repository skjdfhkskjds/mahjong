import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../adapters/transport/table-socket-status.js";
import { GamePanel } from "./app.js";

const actors = [
  { displayName: "east player", id: "actor:east" },
  { displayName: "south player", id: "actor:south" },
  { displayName: "west player", id: "actor:west" },
  { displayName: "north player", id: "actor:north" },
] as const;

const snapshot: ViewerSafeTableSnapshot = {
  protocolVersion: 1,
  stateVersion: 12,
  type: "table/snapshot",
  view: {
    game: {
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
          seat: "east",
        },
        ...(["south", "west", "north"] as const).map((seat) => ({
          bonuses: [],
          concealedCount: 13,
          discards: [],
          seat,
        })),
      ],
      turn: "east",
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
  protocolVersion: 1,
  stateVersion: 12,
  type: "table/receipt",
};

describe("GamePanel", () => {
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
});
