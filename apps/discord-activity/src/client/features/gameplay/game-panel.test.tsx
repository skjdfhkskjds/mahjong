import { bonusTileKinds } from "@mahjong/rules-hong-kong";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { GameAssetsProvider } from "../../presentation/game-assets-provider.js";
import { defaultGameAssetSet } from "../../presentation/assets/sample-asset-sets.js";

function renderToStaticMarkup(element: ReactElement) {
  return renderMarkup(
    <GameAssetsProvider assets={defaultGameAssetSet}>
      {element}
    </GameAssetsProvider>,
  );
}
import { describe, expect, it, vi } from "vitest";

import type { GameDisplay, GamePanelProps } from "./game-display.js";
import { GamePanel } from "./game-panel.js";

const tile = {
  id: 4,
  kind: { type: "suited", suit: "characters", rank: 2 },
  label: "2 characters",
} as const;
const spring = bonusTileKinds.find((kind) => kind.name === "spring");
if (spring === undefined) throw new Error("Spring display fixture is missing.");
const game: GameDisplay = {
  heading: "east to discard",
  wallRemaining: 60,
  deadlineStatus: "Server deadline is pending.",
  abandoned: false,
  rejectionMessage: null,
  draw: { id: "draw", label: "Draw tile", disabled: false },
  players: [
    {
      seat: "east",
      displayName: "East player",
      kind: "human",
      isTurn: true,
      autopilot: true,
      displayName: "East player",
      kind: "human",
      isTurn: true,
      concealedCount: 1,
      bonuses: [
        {
          id: 136,
          kind: spring,
          label: "spring",
        },
      ],
      discards: [tile],
      melds: [
        {
          id: "meld",
          label: "exposed pung",
          accessibleLabel: "east pung meld",
          sourceSeat: "west",
          tiles: [tile],
        },
      ],
    },
  ],
  reaction: {
    heading: "Discard reaction",
    sourceSeat: "south",
    sourceTile: tile,
    status: "open",
    actions: [{ id: "pass", label: "Pass", disabled: false }],
  },
  hand: [{ ...tile, discardDisabled: false }],
  concealedKongs: [
    { id: "concealed", label: "Concealed kong", disabled: false },
  ],
  addedKongs: [{ id: "added", label: "Added kong", disabled: false }],
  win: { id: "win", label: "Declare self-drawn win", disabled: false },
  result: null,
};
function props(display: GameDisplay | null = game): GamePanelProps {
  return {
    game: display,
    onDraw: vi.fn(),
    onDiscard: vi.fn(),
    onReact: vi.fn(),
    onConcealedKong: vi.fn(),
    onAddedKong: vi.fn(),
    onWin: vi.fn(),
  };
}
function clickButtons(node: ReactNode): void {
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child))
      return;
    if (child.type === "button") child.props.onClick?.();
    clickButtons(child.props.children);
  });
}

describe("GamePanel presentation", () => {
  it("renders focused display props and emits semantic callback arguments", () => {
    const presentation = props();
    const html = renderToStaticMarkup(<GamePanel {...presentation} />);
    for (const text of [
      "east to discard",
      "wall 60",
      "Autopilot",
      "1 concealed",
      "1 bonuses",
      "1 discards",
      "spring",
      "exposed pung",
      "from west",
      "2 characters",
      "Your concealed tiles",
      "Discard reaction",
      "Pass",
      "Concealed kong",
      "Added kong",
      "Declare self-drawn win",
    ])
      expect(html).toContain(text);
    clickButtons(GamePanel(presentation));
    expect(presentation.onDraw).toHaveBeenCalledExactlyOnceWith();
    expect(presentation.onDiscard).toHaveBeenCalledExactlyOnceWith(4);
    expect(presentation.onReact).toHaveBeenCalledExactlyOnceWith("pass");
    expect(presentation.onConcealedKong).toHaveBeenCalledExactlyOnceWith(
      "concealed",
    );
    expect(presentation.onAddedKong).toHaveBeenCalledExactlyOnceWith("added");
    expect(presentation.onWin).toHaveBeenCalledExactlyOnceWith();
  });
  it("renders disabled, rejected, abandoned, submitted and spectator display states", () => {
    const html = renderToStaticMarkup(
      <GamePanel
        {...props({
          ...game,
          abandoned: true,
          rejectionMessage: "The server rejected the action.",
          hand: null,
          draw: { id: "draw", label: "Draw tile", disabled: true },
          reaction: {
            heading: "Discard reaction",
            sourceSeat: "south",
            sourceTile: tile,
            actions: [],
            status: "submitted",
          },
        })}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("This table was abandoned");
    expect(html).toContain("The server rejected the action.");
    expect(html).toContain("Response submitted.");
    expect(html).toContain(
      "Spectators receive public tiles and concealed counts only.",
    );
    expect(html).not.toContain('aria-label="Your concealed tiles"');
    expect(html).not.toContain(">Pass<");
    expect(GamePanel(props(null))).toBeNull();
  });
  it("renders the score explanation and exact payments without a full result payload", () => {
    const html = renderToStaticMarkup(
      <GamePanel
        {...props({
          ...game,
          result: {
            winnerSeat: "west",
            cappedFaan: 4,
            tablePoints: 16,
            source: "self-pick",
            eligibilityFaan: 3,
            bonusFaan: 1,
            rawFaan: 4,
            awardedPatterns: [{ id: "all-triplets", faan: 3 }],
            suppressedPatterns: [
              {
                id: "fully-concealed",
                by: "all-triplets",
                reason: "specific-condition",
              },
            ],
            payments: [
              { seat: "east", amount: -8 },
              { seat: "south", amount: -8 },
              { seat: "west", amount: 24 },
              { seat: "north", amount: -8 },
            ],
            paymentTotal: 0,
          },
        })}
      />,
    );
    expect(html).toContain("west wins");
    expect(html).toContain("all-triplets (+3 faan)");
    expect(html).toContain("fully-concealed suppressed by all-triplets");
    expect(html).toContain("<dt>west</dt><dd>+24</dd>");
    expect(html).toContain("<dt>Total</dt><dd>+0</dd>");
  });
});
