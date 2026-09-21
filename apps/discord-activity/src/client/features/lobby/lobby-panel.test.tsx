import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { GameAssetsProvider } from "../../presentation/game-assets-provider.js";
import { defaultGameAssetSet } from "../../presentation/assets/sample-asset-sets.js";

import { describe, expect, it, vi } from "vitest";

import type { LobbyPanelProps, LobbySeatDisplay } from "./lobby-display.js";
import { LobbyPanel, LobbySeat } from "./lobby-panel.js";

function renderToStaticMarkup(element: ReactElement) {
  return renderMarkup(
    <GameAssetsProvider assets={defaultGameAssetSet}>
      {element}
    </GameAssetsProvider>,
  );
}

function buttons(
  node: ReactNode,
): readonly { readonly onClick?: () => void; readonly disabled?: boolean }[] {
  return Children.toArray(node).flatMap((child) => {
    if (
      !isValidElement<{
        readonly children?: ReactNode;
        readonly onClick?: () => void;
        readonly disabled?: boolean;
      }>(child)
    )
      return [];
    return child.type === "button"
      ? [child.props]
      : buttons(child.props.children);
  });
}

const seat: LobbySeatDisplay = {
  seat: "east",
  displayName: "East player",
  kind: "human",
  ready: true,
  status: "Ready",
  disabled: false,
  claimLabel: "Claim east seat",
  readinessLabel: "Mark not ready",
  onClaimSeat: undefined,
  onToggleReady: undefined,
  onLeaveSeat: undefined,
  botControlsDisabled: false,
  onAddBot: undefined,
  onRemoveBot: undefined,
};
const panel: LobbyPanelProps = {
  connectionStatus: "Connected",
  error: undefined,
  botHelp: undefined,
  seats: [seat],
  spectators: [{ id: "guest", displayName: "Guest" }],
  startDisabled: false,
  onStartHand: undefined,
};

describe("lobby presentation", () => {
  it("renders mapped human and bot artwork without giving vacant seats an identity", () => {
    const markup = renderToStaticMarkup(
      <LobbyPanel
        {...panel}
        seats={[
          seat,
          { ...seat, seat: "south", displayName: "Practice bot", kind: "bot" },
          { ...seat, seat: "west", displayName: "Open seat", kind: null },
        ]}
      />,
    );
    expect(markup).toContain('aria-label="East player, human"');
    expect(markup).toContain('aria-label="Practice bot, bot"');
    expect(markup).not.toContain('aria-label="Open seat,');
    expect(markup.match(/class="player-icon"/gu)).toHaveLength(2);
  });

  it("renders seat and spectator display props without network state", () => {
    const markup = renderToStaticMarkup(<LobbyPanel {...panel} />);
    expect(markup).toContain("East player");
    expect(markup).toContain("ready-chip--ready");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Spectators (1)");
    expect(markup).toContain("Guest");
    expect(markup).not.toContain("Start hand");
  });

  it("renders placeholder and error states accessibly", () => {
    const placeholder = renderToStaticMarkup(
      <LobbyPanel {...panel} seats={undefined} />,
    );
    expect(placeholder).toContain('role="status"');
    expect(placeholder).toContain("The lobby will appear");
    const error = renderToStaticMarkup(
      <LobbyPanel {...panel} error="Please try again." spectators={[]} />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("Please try again.");
    expect(error).toContain("No spectators");
  });

  it("emits semantic seat and start callbacks and renders disabled hints", () => {
    const onClaimSeat = vi.fn();
    const onToggleReady = vi.fn();
    const onLeaveSeat = vi.fn();
    const onStartHand = vi.fn();
    const seatButtons = buttons(
      LobbySeat({ seat: { ...seat, onClaimSeat, onToggleReady, onLeaveSeat } }),
    );
    expect(seatButtons).toHaveLength(3);
    for (const button of seatButtons) button.onClick?.();
    expect(onClaimSeat).toHaveBeenCalledExactlyOnceWith();
    expect(onToggleReady).toHaveBeenCalledExactlyOnceWith();
    expect(onLeaveSeat).toHaveBeenCalledExactlyOnceWith();
    buttons(LobbyPanel({ ...panel, onStartHand }))[0]?.onClick?.();
    expect(onStartHand).toHaveBeenCalledExactlyOnceWith();
    const disabled = buttons(
      LobbySeat({
        seat: {
          ...seat,
          disabled: true,
          onClaimSeat,
          onToggleReady,
          onLeaveSeat,
        },
      }),
    );
    expect(disabled.every((button) => button.disabled)).toBe(true);
    expect(
      buttons(LobbyPanel({ ...panel, onStartHand, startDisabled: true }))[0]
        ?.disabled,
    ).toBe(true);
  });
});

it("renders semantic bot controls and calls their spies without actor identifiers", () => {
  const onAddBot = vi.fn();
  const onRemoveBot = vi.fn();
  const vacant = { ...seat, kind: null, onAddBot };
  const bot = {
    ...seat,
    kind: "bot" as const,
    displayName: "Bot East",
    onRemoveBot,
  };
  const markup = renderToStaticMarkup(
    <LobbyPanel {...panel} botHelp="Owner bot controls" seats={[bot]} />,
  );
  expect(markup).toContain("Owner bot controls");
  expect(markup).toContain("Bot East");
  expect(markup).toContain("Remove bot");
  buttons(LobbySeat({ seat: vacant }))[0]?.onClick?.();
  buttons(LobbySeat({ seat: bot }))[0]?.onClick?.();
  expect(onAddBot).toHaveBeenCalledExactlyOnceWith();
  expect(onRemoveBot).toHaveBeenCalledExactlyOnceWith();
  expect(
    buttons(LobbySeat({ seat: { ...bot, botControlsDisabled: true } }))[0]
      ?.disabled,
  ).toBe(true);
});
