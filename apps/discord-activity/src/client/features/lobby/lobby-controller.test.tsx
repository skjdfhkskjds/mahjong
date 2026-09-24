import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { GameAssetsProvider } from "../../presentation/game-assets-provider.js";
import { defaultGameAssetSet } from "../../presentation/assets/sample-asset-sets.js";

import { describe, expect, it, vi } from "vitest";

import type {
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";
import { createLobbyDisplay, LobbyController } from "./lobby-controller.js";

function renderToStaticMarkup(element: ReactElement) {
  return renderMarkup(
    <GameAssetsProvider assets={defaultGameAssetSet}>
      {element}
    </GameAssetsProvider>,
  );
}

const actor = { id: "actor:east", displayName: "East player" };
const snapshot: ViewerSafeTableSnapshot = {
  protocolVersion: 1,
  stateVersion: 4,
  type: "table/snapshot",
  view: {
    phase: "lobby",
    seats: (["east", "south", "west", "north"] as const).map((seat) => ({
      seat,
      occupant: seat === "east" ? actor : null,
      ready: false,
      autopilot: false,
    })),
    spectators: [{ id: "actor:spectator", displayName: "Guest" }],
    tableId: "table:lobby-test",
    viewer: { actor, role: "player", seat: "east" },
  },
};

function display(
  overrides: Partial<Parameters<typeof createLobbyDisplay>[0]> = {},
) {
  return createLobbyDisplay({
    connected: true,
    latestReceipt: undefined,
    onCommand: vi.fn(() => true),
    snapshot,
    ...overrides,
  });
}

describe("lobby controller", () => {
  it("maps seat ownership, readiness, vacancy, and spectators into display props", () => {
    const model = display();
    expect(model.connectionStatus).toBe("Connected · state 4");
    expect(model.seats?.[0]).toMatchObject({
      displayName: "East player",
      ready: false,
      status: "Not ready",
      readinessLabel: "Mark ready",
    });
    expect(model.seats?.[0]?.onToggleReady).toBeTypeOf("function");
    expect(model.seats?.[0]?.onClaimSeat).toBeUndefined();
    expect(model.seats?.[1]).toMatchObject({
      displayName: "Open seat",
      status: "Vacant",
      claimLabel: "Move to south seat",
    });
    expect(model.seats?.[1]?.onToggleReady).toBeUndefined();
    expect(model.seats?.[1]?.onLeaveSeat).toBeUndefined();
    expect(model.spectators).toEqual([
      { id: "actor:spectator", displayName: "Guest" },
    ]);
    expect(model.onStartHand).toBeUndefined();
  });

  it("translates seat, ready, leave, and start callbacks into exact commands", () => {
    const onCommand = vi.fn(() => true);
    const model = display({ onCommand });
    model.seats?.[1]?.onClaimSeat?.();
    model.seats?.[0]?.onToggleReady?.();
    model.seats?.[0]?.onLeaveSeat?.();
    const ready = display({
      onCommand,
      snapshot: {
        ...snapshot,
        view: {
          ...snapshot.view,
          seats: snapshot.view.seats.map((seat) => ({
            ...seat,
            ready: true,
            occupant: { id: `actor:${seat.seat}`, displayName: seat.seat },
          })),
        },
      },
    });
    ready.seats?.[0]?.onToggleReady?.();
    ready.onStartHand?.();
    expect(onCommand.mock.calls).toEqual([
      [{ type: "lobby/claim-seat", seat: "south" }],
      [{ type: "lobby/set-ready", ready: true }],
      [{ type: "lobby/leave-seat" }],
      [{ type: "lobby/set-ready", ready: false }],
      [{ type: "game/start" }],
    ]);
  });

  it("offers spectators claims but no player readiness, leave, or start hint", () => {
    const model = display({
      snapshot: {
        ...snapshot,
        view: { ...snapshot.view, viewer: { actor, role: "spectator" } },
      },
    });
    expect(model.seats?.[1]?.claimLabel).toBe("Claim south seat");
    expect(
      model.seats?.every(
        (seat) =>
          seat.onToggleReady === undefined && seat.onLeaveSeat === undefined,
      ),
    ).toBe(true);
    expect(model.onStartHand).toBeUndefined();
  });

  it("disables controls on reconnect and restores the reserved seat from the new snapshot", () => {
    const onCommand = vi.fn(() => true);
    const disconnected = display({ connected: false, onCommand });
    expect(disconnected.connectionStatus).toBe(
      "Controls unavailable while reconnecting",
    );
    expect(disconnected.seats?.every((seat) => seat.disabled)).toBe(true);
    disconnected.seats?.[0]?.onToggleReady?.();
    disconnected.seats?.[1]?.onClaimSeat?.();
    expect(onCommand).not.toHaveBeenCalled();
    const reconnected = display({ snapshot: { ...snapshot }, onCommand });
    expect(reconnected.seats?.[0]?.displayName).toBe("East player");
    reconnected.seats?.[0]?.onToggleReady?.();
    expect(onCommand).toHaveBeenCalledWith({
      type: "lobby/set-ready",
      ready: true,
    });
    expect(display({ snapshot: undefined }).seats).toBeUndefined();
  });

  it("shows rejection feedback without changing readiness or claiming authority", () => {
    const latestReceipt: TableReceipt = {
      type: "table/receipt",
      protocolVersion: 1,
      commandId: "rejected",
      stateVersion: 4,
      outcome: "rejected",
      error: { code: "not-ready", message: "Players are not ready." },
    };
    const rejected = display({ latestReceipt });
    expect(rejected.error).toBe("Players are not ready.");
    expect(rejected.seats?.[0]?.ready).toBe(false);
    expect(
      display({ latestReceipt: { ...latestReceipt, outcome: "applied" } })
        .error,
    ).toBeUndefined();
    const withoutError = { ...latestReceipt };
    delete withoutError.error;
    expect(display({ latestReceipt: withoutError }).error).toBe(
      "The table rejected that action.",
    );
    const markup = renderToStaticMarkup(
      <LobbyController
        connected
        latestReceipt={latestReceipt}
        onCommand={vi.fn()}
        snapshot={snapshot}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Players are not ready.");
  });
});

const botLobby: ViewerSafeTableSnapshot = {
  ...snapshot,
  view: {
    ...snapshot.view,
    seats: snapshot.view.seats.map((seat) => ({
      ...seat,
      ready: seat.seat === "south",
      autopilot: seat.seat === "north",
      occupant:
        seat.seat === "south"
          ? { id: "bot:dedicated", displayName: "Bot South" }
          : seat.seat === "north"
            ? { id: "actor:north", displayName: "Bot named human" }
            : seat.occupant,
    })),
  },
};

describe("lobby bot management controller", () => {
  it("maps dedicated bots independently of human names and temporary autopilot", () => {
    const model = display({ canManageBots: true, snapshot: botLobby });
    expect(model.seats?.map(({ kind }) => kind)).toEqual([
      "human",
      "bot",
      null,
      "human",
    ]);
    expect(model.seats?.[1]).toMatchObject({
      displayName: "Bot South",
      ready: true,
      status: "Ready",
    });
    expect(model.seats?.[1]?.onRemoveBot).toBeTypeOf("function");
    expect(model.seats?.[3]?.onRemoveBot).toBeUndefined();
    expect(model.seats?.[1]?.onToggleReady).toBeUndefined();
    expect(model.seats?.[0]?.ready).toBe(false);
    expect(model.onStartHand).toBeUndefined();
  });

  it("translates seated-owner bot intents exactly without optimistic occupancy changes", () => {
    const onCommand = vi.fn(() => true);
    const model = display({
      canManageBots: true,
      snapshot: botLobby,
      onCommand,
    });
    model.seats?.[2]?.onAddBot?.();
    model.seats?.[1]?.onRemoveBot?.();
    expect(onCommand.mock.calls).toEqual([
      [{ type: "lobby/add-bot", seat: "west" }],
      [{ type: "lobby/remove-bot", seat: "south" }],
    ]);
    expect(model.seats?.[2]?.kind).toBeNull();
    expect(model.seats?.[1]?.kind).toBe("bot");
    expect(model.seats?.[0]?.onRemoveBot).toBeUndefined();
    expect(model.seats?.[1]?.onAddBot).toBeUndefined();
  });

  it("hides non-owner bot controls and disables owner spectators and reconnecting owners", () => {
    const member = display({ snapshot: botLobby });
    expect(member.botHelp).toBeUndefined();
    expect(
      member.seats?.every((seat) => !seat.onAddBot && !seat.onRemoveBot),
    ).toBe(true);
    const spectator: ViewerSafeTableSnapshot = {
      ...botLobby,
      view: { ...botLobby.view, viewer: { actor, role: "spectator" } },
    };
    for (const state of [
      { snapshot: spectator, connected: true },
      { snapshot: botLobby, connected: false },
    ]) {
      const onCommand = vi.fn(() => true);
      const model = display({ ...state, canManageBots: true, onCommand });
      expect(model.botHelp).toContain("Claim a seat");
      expect(model.seats?.every((seat) => seat.botControlsDisabled)).toBe(true);
      model.seats?.[2]?.onAddBot?.();
      model.seats?.[1]?.onRemoveBot?.();
      expect(onCommand).not.toHaveBeenCalled();
    }
  });

  it("restores bot controls from a reconnect snapshot and preserves server rejection feedback", () => {
    const onCommand = vi.fn(() => true);
    const reconnected = display({
      canManageBots: true,
      snapshot: { ...botLobby },
      onCommand,
    });
    expect(reconnected.seats?.[1]?.botControlsDisabled).toBe(false);
    reconnected.seats?.[1]?.onRemoveBot?.();
    const rejected = display({
      canManageBots: true,
      snapshot: botLobby,
      latestReceipt: {
        type: "table/receipt",
        protocolVersion: 1,
        commandId: "remove-bot",
        stateVersion: 4,
        outcome: "rejected",
        error: {
          code: "not-owner",
          message: "Only the owner can manage bots.",
        },
      },
    });
    expect(rejected.error).toBe("Only the owner can manage bots.");
    expect(rejected.seats?.[1]?.kind).toBe("bot");
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({
      type: "lobby/remove-bot",
      seat: "south",
    });
  });
});
