import type { Seat, TileId } from "@mahjong/game-core";

import type { DeclaredMeld } from "../melds/meld.js";
import type { PlayerReactionResponse } from "./game-state.js";
import type { CompletedHandResult } from "./win-resolution.js";

export type HongKongTurnStage =
  "awaiting-dealer-discard" | "awaiting-draw" | "awaiting-discard";

export type HongKongMoveError =
  | "draw-not-allowed"
  | "discard-not-allowed"
  | "replacement-required"
  | "tile-not-in-hand"
  | "concealed-kong-not-allowed"
  | "added-kong-not-allowed"
  | "win-not-allowed"
  | "illegal-reaction";

export type KongReplacement =
  | { readonly kind: "drawn"; readonly tileIds: readonly TileId[] }
  | { readonly kind: "exhausted"; readonly tileIds: readonly TileId[] };

export type HongKongMoveOutcome =
  | {
      readonly kind: "drawn";
      readonly ordinaryTileId: TileId;
      readonly replacementTileIds: readonly TileId[];
    }
  | {
      readonly kind: "exhausted";
      readonly requiredDraw: "ordinary" | "bonus-replacement";
    }
  | {
      readonly kind: "discarded";
      readonly tileId: TileId;
      readonly windowId: string;
    }
  | {
      readonly kind: "concealed-kong";
      readonly meld: DeclaredMeld;
      readonly replacement: KongReplacement;
    }
  | {
      readonly kind: "added-kong-proposed";
      readonly meldId: string;
      readonly tileId: TileId;
      readonly windowId: string;
    };

export interface HongKongSubmission {
  readonly seat: Seat;
  readonly response: PlayerReactionResponse;
}

export type HongKongReactionOutcome =
  | { readonly kind: "all-pass" }
  | {
      readonly kind: "meld-claimed";
      readonly seat: Seat;
      readonly response: Extract<
        PlayerReactionResponse,
        { type: "chow" | "pung" }
      >;
    }
  | {
      readonly kind: "kong-claimed";
      readonly seat: Seat;
      readonly response: Extract<PlayerReactionResponse, { type: "kong" }>;
      readonly replacement: KongReplacement;
    }
  | {
      readonly kind: "added-kong-completed";
      readonly seat: Seat;
      readonly replacement: KongReplacement;
    }
  | {
      readonly kind: "hand-won";
      readonly result: CompletedHandResult;
      /** Authority-only: never include losing claimants in viewer projections. */
      readonly claimants: readonly {
        readonly seat: Seat;
        readonly award: "awarded" | "not-awarded";
      }[];
    };

export type HongKongResolution =
  | { readonly kind: "self-win"; readonly result: CompletedHandResult }
  | {
      readonly kind: "reaction";
      readonly windowId: string;
      readonly outcome: HongKongReactionOutcome;
    };
