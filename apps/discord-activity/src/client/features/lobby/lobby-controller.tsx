import type {
  TableCommand,
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";
import { mapPlayerIdentity } from "../players/player-display.js";
import type { LobbyPanelProps } from "./lobby-display.js";
import { LobbyPanel } from "./lobby-panel.js";

export interface LobbyControllerProps {
  readonly canManageBots?: boolean;
  readonly connected: boolean;
  readonly latestReceipt: TableReceipt | undefined;
  readonly onCommand: (command: TableCommand) => boolean;
  readonly snapshot: ViewerSafeTableSnapshot | undefined;
}

export function createLobbyDisplay({
  canManageBots = false,
  connected,
  latestReceipt,
  onCommand,
  snapshot,
}: LobbyControllerProps): LobbyPanelProps {
  const viewer = snapshot?.view.viewer;
  const botControlsDisabled = !connected || viewer?.role !== "player";
  const submit = (command: TableCommand) => () => {
    if (connected) onCommand(command);
  };

  return {
    botHelp: canManageBots
      ? "Claim a seat, then add bots to empty seats to play solo or with friends. Bots make random legal moves and are ready automatically."
      : undefined,
    connectionStatus:
      connected && snapshot
        ? `Connected · state ${String(snapshot.stateVersion)}`
        : "Controls unavailable while reconnecting",
    error:
      latestReceipt?.outcome === "rejected"
        ? (latestReceipt.error?.message ?? "The table rejected that action.")
        : undefined,
    seats: snapshot?.view.seats.map((seat) => {
      const identity = seat.occupant ? mapPlayerIdentity(seat.occupant) : null;
      const isViewerSeat =
        viewer?.role === "player" && viewer.seat === seat.seat;
      return {
        seat: seat.seat,
        displayName: identity?.displayName ?? "Open seat",
        kind: identity?.kind ?? null,
        ready: seat.ready,
        status: seat.occupant ? (seat.ready ? "Ready" : "Not ready") : "Vacant",
        disabled: !connected,
        claimLabel: `${viewer?.role === "player" ? "Move to" : "Claim"} ${seat.seat} seat`,
        readinessLabel: seat.ready ? "Mark not ready" : "Mark ready",
        onClaimSeat:
          viewer && !seat.occupant
            ? submit({ type: "lobby/claim-seat", seat: seat.seat })
            : undefined,
        onToggleReady: isViewerSeat
          ? submit({ type: "lobby/set-ready", ready: !seat.ready })
          : undefined,
        onLeaveSeat: isViewerSeat
          ? submit({ type: "lobby/leave-seat" })
          : undefined,
        botControlsDisabled,
        onAddBot:
          canManageBots && !seat.occupant
            ? () => {
                if (!botControlsDisabled)
                  onCommand({ type: "lobby/add-bot", seat: seat.seat });
              }
            : undefined,
        onRemoveBot:
          canManageBots && identity?.kind === "bot"
            ? () => {
                if (!botControlsDisabled)
                  onCommand({ type: "lobby/remove-bot", seat: seat.seat });
              }
            : undefined,
      };
    }),
    spectators:
      snapshot?.view.spectators.map(({ id, displayName }) => ({
        id,
        displayName,
      })) ?? [],
    startDisabled: !connected,
    // A usability hint only: the server rechecks readiness and start authority.
    onStartHand:
      viewer?.role === "player" &&
      snapshot?.view.seats.every(
        ({ occupant, ready }) => occupant !== null && ready,
      )
        ? submit({ type: "game/start" })
        : undefined,
  };
}

export function LobbyController(props: LobbyControllerProps) {
  return <LobbyPanel {...createLobbyDisplay(props)} />;
}
