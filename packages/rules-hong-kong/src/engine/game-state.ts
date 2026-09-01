import type { Seat, TileId } from "@mahjong/game-core";

import type { DeclaredMeld } from "../melds/meld.js";
import type { CompletedHandResult } from "./win-resolution.js";
import type { HONG_KONG_V1_SHUFFLE_ALGORITHM } from "../wall/deterministic-shuffle.js";

export type LegacyGamePhase =
  | "awaiting-dealer-discard"
  | "awaiting-draw"
  | "awaiting-discard"
  | "exhausted";

export type GamePhase =
  | "awaiting-dealer-discard"
  | "awaiting-draw"
  | "awaiting-discard"
  | "awaiting-discard-reactions"
  | "awaiting-added-kong-reactions"
  | "pending-win-validation"
  | "complete"
  | "exhausted";

export interface SeatMap<Value> {
  readonly east: Value;
  readonly south: Value;
  readonly west: Value;
  readonly north: Value;
}

type SeatName = "east" | "south" | "west" | "north";

export function seatName(value: Seat): SeatName {
  return value;
}

export function playerAt<Value>(players: SeatMap<Value>, value: Seat): Value {
  return players[seatName(value)];
}

export interface CanonicalPlayerStateV1 {
  readonly actorId: string;
  readonly bonuses: readonly TileId[];
  readonly discards: readonly TileId[];
  readonly hand: readonly TileId[];
  readonly seat: Seat;
}

export interface CanonicalPlayerStateV2 extends CanonicalPlayerStateV1 {
  readonly melds: readonly DeclaredMeld[];
}

export type CanonicalPlayerState =
  CanonicalPlayerStateV1 | CanonicalPlayerStateV2;

export interface CanonicalWallState {
  readonly head: number;
  readonly order: readonly TileId[];
  readonly tail: number;
}

export interface CanonicalGameStateV1 {
  readonly phase: LegacyGamePhase;
  readonly players: SeatMap<CanonicalPlayerStateV1>;
  readonly ruleset: "hong-kong/v1";
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly shuffleAlgorithm: typeof HONG_KONG_V1_SHUFFLE_ALGORITHM;
  readonly turn: Seat;
  readonly wall: CanonicalWallState;
}

export type ReactionKind = "added-kong" | "discard";

export type ReactionResponse =
  | { readonly type: "pass" }
  | { readonly type: "chow"; readonly handTileIds: readonly [TileId, TileId] }
  | { readonly type: "pung"; readonly handTileIds: readonly [TileId, TileId] }
  | {
      readonly type: "kong";
      readonly handTileIds: readonly [TileId, TileId, TileId];
    }
  | { readonly type: "win"; readonly structurallyEligible: true };

export type PlayerReactionResponse =
  | Exclude<ReactionResponse, { readonly type: "win" }>
  | { readonly type: "win" };

export interface SubmittedReactionIntent {
  readonly response: ReactionResponse;
  readonly seat: Seat;
}

interface ReactionWindowBase {
  readonly id: string;
  readonly intents: Readonly<Record<string, SubmittedReactionIntent>>;
  readonly kind: ReactionKind;
  readonly openingSequence: number;
  readonly responderOrder: readonly [Seat, Seat, Seat];
  readonly sourceIsOpeningEastDiscard: boolean;
  readonly sourceLastCatch: boolean;
  readonly sourceSeat: Seat;
  readonly sourceTileId: TileId;
}

export interface DiscardReactionWindow extends ReactionWindowBase {
  readonly kind: "discard";
}

export interface AddedKongReactionWindow extends ReactionWindowBase {
  readonly kind: "added-kong";
  readonly sourceMeldId: string;
}

export type ReactionWindow = DiscardReactionWindow | AddedKongReactionWindow;

export interface TurnProvenance {
  readonly eastHasDiscarded: boolean;
  readonly eastHasDeclaredKong: boolean;
  readonly lastAcquiredTileId: TileId | null;
  readonly lastAcquiredTileWasFinalWall: boolean;
  readonly lastAcquisition:
    "bonus-replacement" | "deal" | "draw" | "kong-replacement" | null;
  readonly replacementChainDepth: number;
  readonly replacementPending: boolean;
}

export type CompletionProvenance =
  | {
      readonly acquiredTileWasFinalWall: boolean;
      readonly eastHadDeclaredKong: boolean;
      readonly eastHadDiscarded: boolean;
      readonly kind: "self-pick";
      readonly kongReplacementChainDepth: number;
      readonly lastAcquisition: Exclude<
        TurnProvenance["lastAcquisition"],
        null
      >;
      readonly winnerSeat: Seat;
      readonly winningTileId: TileId;
    }
  | {
      readonly kind: "discard" | "robbing-kong";
      readonly sourceIsOpeningEastDiscard: boolean;
      readonly sourceLastCatch: boolean;
      readonly sourceSeat: Seat;
      readonly winnerSeat: Seat;
      readonly winningTileId: TileId;
    };

export interface CanonicalGameStateV2 {
  readonly completionProvenance: CompletionProvenance | null;
  readonly phase: GamePhase;
  readonly players: SeatMap<CanonicalPlayerStateV2>;
  readonly prevailingWind: "east";
  readonly reactionWindow: ReactionWindow | null;
  readonly result: CompletedHandResult | null;
  readonly ruleset: "hong-kong/v1";
  readonly schemaVersion: 2;
  readonly sequence: number;
  readonly shuffleAlgorithm: typeof HONG_KONG_V1_SHUFFLE_ALGORITHM;
  readonly turn: Seat;
  readonly turnProvenance: TurnProvenance;
  readonly wall: CanonicalWallState;
}

/** Historical unversioned name retained for deployed schema-v1 callers. */
export type CanonicalGameState = CanonicalGameStateV1;
export type VersionedCanonicalGameState =
  CanonicalGameStateV1 | CanonicalGameStateV2;

export function isCanonicalGameStateV2(
  state: VersionedCanonicalGameState,
): state is CanonicalGameStateV2 {
  return state.schemaVersion === 2;
}
