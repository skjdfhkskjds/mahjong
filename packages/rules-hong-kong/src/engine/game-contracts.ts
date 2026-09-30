import type { Seat, TileId } from "@mahjong/game-core";

import type {
  NormalizedReaction,
  ReactionOutcome,
} from "../claims/reaction-resolution.js";
import type { DeclaredMeld } from "../melds/meld.js";
import type { HongKongTileKind } from "../tiles/hong-kong-tile-kind.js";
import type {
  CanonicalGameStateV1,
  GamePhase,
  PlayerReactionResponse,
  ReactionResponse,
  ReactionWindow,
} from "./game-state.js";
import type { CompletedHandResult } from "./win-resolution.js";

export interface StartedEventV1 {
  readonly type: "game/started";
  readonly sequence: 1;
  readonly state: CanonicalGameStateV1;
}

export interface DrawnEvent {
  readonly type: "game/turn-drawn";
  readonly sequence: number;
  readonly seat: Seat;
  readonly ordinaryTileId: TileId;
  readonly replacementTileIds: readonly TileId[];
  readonly exhausted: boolean;
}

export interface ExhaustedEvent {
  readonly type: "game/wall-exhausted";
  readonly sequence: number;
  readonly seat: Seat;
  readonly requiredDraw: "ordinary";
}

export interface DiscardReactionOpenedEvent {
  readonly type: "game/discard-reaction-opened";
  readonly sequence: number;
  readonly seat: Seat;
  readonly tileId: TileId;
  readonly windowId: string;
}

export interface ReactionIntentSubmittedEvent {
  readonly type: "game/reaction-intent-submitted";
  readonly sequence: number;
  readonly actorId: string;
  readonly response: ReactionResponse;
  readonly seat: Seat;
  readonly windowId: string;
}

export interface ReactionResolvedEvent {
  readonly type: "game/reaction-resolved";
  readonly sequence: number;
  readonly outcome: ReactionOutcome;
  readonly responses: readonly NormalizedReaction[];
  readonly windowId: string;
}

export interface ConcealedKongDeclaredEvent {
  readonly type: "game/concealed-kong-declared";
  readonly sequence: number;
  readonly meld: DeclaredMeld;
  readonly seat: Seat;
}

export interface AddedKongProposedEvent {
  readonly type: "game/added-kong-proposed";
  readonly sequence: number;
  readonly meldId: string;
  readonly seat: Seat;
  readonly tileId: TileId;
  readonly windowId: string;
}

export interface KongReplacementDrawnEvent {
  readonly type: "game/kong-replacement-drawn";
  readonly sequence: number;
  readonly exhausted: boolean;
  readonly seat: Seat;
  readonly tileIds: readonly TileId[];
}

export interface SelfWinDeclaredEvent {
  readonly type: "game/self-win-declared";
  readonly sequence: number;
  readonly seat: Seat;
}

export interface HandCompletedEvent {
  readonly type: "game/hand-completed";
  readonly sequence: number;
  readonly result: CompletedHandResult;
}

export type HongKongGameEventV1 =
  | AddedKongProposedEvent
  | ConcealedKongDeclaredEvent
  | DiscardReactionOpenedEvent
  | DrawnEvent
  | ExhaustedEvent
  | HandCompletedEvent
  | KongReplacementDrawnEvent
  | ReactionIntentSubmittedEvent
  | ReactionResolvedEvent
  | SelfWinDeclaredEvent
  | StartedEventV1;

export type HongKongGameEvent = HongKongGameEventV1;

export type HongKongGameCommandV1 =
  | { readonly type: "game/draw" }
  | { readonly type: "game/discard"; readonly tileId: TileId }
  | {
      readonly type: "game/react";
      readonly response: PlayerReactionResponse;
      readonly windowId: string;
    }
  | {
      readonly type: "game/declare-concealed-kong";
      readonly tileIds: readonly [TileId, TileId, TileId, TileId];
    }
  | {
      readonly type: "game/propose-added-kong";
      readonly meldId: string;
      readonly tileId: TileId;
    }
  | { readonly type: "game/declare-win" };

export type HongKongGameCommand = HongKongGameCommandV1;

export interface RejectedGameDecision {
  readonly accepted: false;
  readonly error: { readonly code: string; readonly message: string };
}

export type NonEmptyGameEventBatch = readonly [
  HongKongGameEventV1,
  ...HongKongGameEventV1[],
];

export type GameDecisionV1 =
  | { readonly accepted: true; readonly events: NonEmptyGameEventBatch }
  | RejectedGameDecision;

export type GameDecision = GameDecisionV1;

export interface PublicTile {
  readonly id: TileId;
  readonly kind: HongKongTileKind;
}

export interface PublicMeld {
  readonly exposure: DeclaredMeld["exposure"];
  readonly id: string;
  readonly kind: DeclaredMeld["kind"];
  readonly tileIds: readonly PublicTile[];
  readonly claimedTileId?: TileId;
  readonly kongKind?: DeclaredMeld["kongKind"];
  readonly sourceSeat?: Seat;
}

export type PublicReactionAction = PlayerReactionResponse;

export interface GameViewV1 {
  readonly phase: Exclude<GamePhase, "pending-win-validation">;
  readonly players: readonly {
    readonly bonuses: readonly PublicTile[];
    readonly concealedCount: number;
    readonly discards: readonly PublicTile[];
    readonly melds?: readonly PublicMeld[];
    readonly seat: Seat;
  }[];
  readonly reaction?: {
    readonly kind: ReactionWindow["kind"];
    readonly sourceMeldId?: string;
    readonly sourceSeat: Seat;
    readonly sourceTile: PublicTile;
    readonly windowId: string;
  };
  readonly turn: Seat;
  readonly result?: CompletedHandResult;
  readonly viewerActions?: {
    readonly reaction?: {
      readonly actions: readonly PublicReactionAction[];
      readonly status: "open" | "submitted";
      readonly windowId: string;
    };
    readonly self: readonly HongKongGameCommandV1[];
  };
  readonly viewerHand?: readonly PublicTile[];
  readonly wallRemaining: number;
}

export type GameView = GameViewV1;
