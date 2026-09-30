import type { HongKongTileKind, SeatMap } from "@mahjong/rules-hong-kong";

import type { ActionIcon } from "../../presentation/assets/game-asset-set.js";

export type TileKindDisplay = HongKongTileKind;
export type SeatDisplay = keyof SeatMap<unknown>;

export interface TileDisplay {
  readonly id: number;
  readonly kind?: TileKindDisplay;
  readonly label: string;
}

export interface GameActionDisplay {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly artworkAction?: ActionIcon;
  readonly tiles?: readonly TileDisplay[];
}

export interface PlayerDisplay {
  readonly seat: SeatDisplay;
  readonly displayName: string;
  readonly kind: "human" | "bot";
  readonly isTurn: boolean;
  readonly autopilot: boolean;
  readonly concealedCount: number;
  readonly bonuses: readonly TileDisplay[];
  readonly discards: readonly TileDisplay[];
  readonly melds: readonly {
    readonly id: string;
    readonly label: string;
    readonly accessibleLabel: string;
    readonly sourceSeat: SeatDisplay | null;
    readonly tiles: readonly TileDisplay[];
  }[];
}

export interface HandResultDisplay {
  readonly winnerSeat: SeatDisplay;
  readonly cappedFaan: number;
  readonly tablePoints: number;
  readonly source: string;
  readonly eligibilityFaan: number;
  readonly bonusFaan: number;
  readonly rawFaan: number;
  readonly awardedPatterns: readonly {
    readonly id: string;
    readonly faan: number;
  }[];
  readonly suppressedPatterns: readonly {
    readonly id: string;
    readonly by: string;
    readonly reason: string;
  }[];
  readonly payments: readonly {
    readonly seat: SeatDisplay;
    readonly amount: number;
  }[];
  readonly paymentTotal: number;
}

export interface GameDisplay {
  readonly heading: string;
  readonly wallRemaining: number;
  readonly deadlineStatus: string | null;
  readonly abandoned: boolean;
  readonly rejectionMessage: string | null;
  readonly draw: GameActionDisplay | null;
  readonly players: readonly PlayerDisplay[];
  readonly reaction: {
    readonly heading: string;
    readonly sourceSeat: SeatDisplay;
    readonly sourceTile: TileDisplay;
    readonly status: "waiting" | "submitted" | "open";
    readonly actions: readonly GameActionDisplay[];
  } | null;
  readonly hand:
    readonly (TileDisplay & { readonly discardDisabled: boolean })[] | null;
  readonly concealedKongs: readonly GameActionDisplay[];
  readonly addedKongs: readonly GameActionDisplay[];
  readonly win: GameActionDisplay | null;
  readonly result: HandResultDisplay | null;
}

export interface GamePanelProps {
  readonly game: GameDisplay | null;
  readonly onDraw: () => void;
  readonly onDiscard: (tileId: number) => void;
  readonly onReact: (actionId: string) => void;
  readonly onConcealedKong: (actionId: string) => void;
  readonly onAddedKong: (actionId: string) => void;
  readonly onWin: () => void;
}
