import type { SeatMap } from "@mahjong/rules-hong-kong";

export interface LobbySeatDisplay {
  readonly seat: keyof SeatMap<unknown>;
  readonly displayName: string;
  readonly kind: "human" | "bot" | null;
  readonly ready: boolean;
  readonly status: string;
  readonly disabled: boolean;
  readonly claimLabel: string;
  readonly readinessLabel: string;
  readonly onClaimSeat: (() => void) | undefined;
  readonly onToggleReady: (() => void) | undefined;
  readonly onLeaveSeat: (() => void) | undefined;
  readonly botControlsDisabled: boolean;
  readonly onAddBot: (() => void) | undefined;
  readonly onRemoveBot: (() => void) | undefined;
}

export interface LobbyPanelProps {
  readonly connectionStatus: string;
  readonly error: string | undefined;
  readonly botHelp: string | undefined;
  readonly seats: readonly LobbySeatDisplay[] | undefined;
  readonly spectators: readonly {
    readonly id: string;
    readonly displayName: string;
  }[];
  readonly startDisabled: boolean;
  readonly onStartHand: (() => void) | undefined;
}
