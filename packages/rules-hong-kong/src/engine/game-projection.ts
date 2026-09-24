import { seats, type Seat, type TileId } from "@mahjong/game-core";

import { legalReactionsForSeat } from "../claims/legal-reactions.js";
import {
  legalAddedKongs,
  legalConcealedKongs,
} from "../kongs/kong-transitions.js";
import { tileKind } from "../tiles/tile-kind-identity.js";
import type {
  GameViewV1,
  HongKongGameCommandV1,
  PublicReactionAction,
  PublicTile,
} from "./game-contracts.js";
import { playerAt, type CanonicalGameStateV1 } from "./game-state.js";
import {
  scoreReactionWinCandidate,
  scoreSelfWinCandidate,
} from "./win-resolution.js";

export type {
  GameView,
  GameViewV1,
  PublicMeld,
  PublicTile,
} from "./game-contracts.js";

export function projectGameV1(
  state: CanonicalGameStateV1,
  viewerActorId: string,
): GameViewV1 {
  if (state.phase === "pending-win-validation") {
    throw new Error("Implementation-only win validation cannot be projected.");
  }
  const viewer = seats
    .map((currentSeat) => playerAt(state.players, currentSeat))
    .find(({ actorId }) => actorId === viewerActorId);
  const publicTile = (id: TileId): PublicTile => ({ id, kind: tileKind(id) });
  const reaction = state.reactionWindow;
  const ownIntent =
    reaction === null ||
    viewer === undefined ||
    !Object.hasOwn(reaction.intents, viewer.actorId)
      ? undefined
      : reaction.intents[viewer.actorId];
  return {
    phase: state.phase,
    players: seats.map((currentSeat) => {
      const player = playerAt(state.players, currentSeat);
      return {
        bonuses: player.bonuses.map(publicTile),
        concealedCount: player.hand.length,
        discards: player.discards.map(publicTile),
        melds: player.melds.map((meld) => ({
          exposure: meld.exposure,
          id: meld.id,
          kind: meld.kind,
          tileIds: meld.tileIds.map(publicTile),
          ...(meld.claimedTileId === undefined
            ? {}
            : { claimedTileId: meld.claimedTileId }),
          ...(meld.kongKind === undefined ? {} : { kongKind: meld.kongKind }),
          ...(meld.sourceSeat === undefined
            ? {}
            : { sourceSeat: meld.sourceSeat }),
        })),
        seat: currentSeat,
      };
    }),
    ...(reaction === null
      ? {}
      : {
          reaction: {
            kind: reaction.kind,
            ...(reaction.kind === "added-kong"
              ? { sourceMeldId: reaction.sourceMeldId }
              : {}),
            sourceSeat: reaction.sourceSeat,
            sourceTile: publicTile(reaction.sourceTileId),
            windowId: reaction.id,
          },
        }),
    turn: state.turn,
    ...(state.result === null ? {} : { result: state.result }),
    ...(viewer === undefined
      ? {}
      : {
          viewerActions: {
            ...(reaction?.responderOrder.includes(viewer.seat) === true
              ? {
                  reaction: {
                    actions:
                      ownIntent === undefined
                        ? legalViewerReactions(state, viewer.seat)
                        : [],
                    status:
                      ownIntent === undefined
                        ? ("open" as const)
                        : ("submitted" as const),
                    windowId: reaction.id,
                  },
                }
              : {}),
            self: legalSelfActions(state, viewer.seat),
          },
          viewerHand: viewer.hand.map(publicTile),
        }),
    wallRemaining: Math.max(0, state.wall.tail - state.wall.head + 1),
  };
}

export const projectGame = projectGameV1;

function legalSelfActions(
  state: CanonicalGameStateV1,
  viewerSeat: Seat,
): readonly HongKongGameCommandV1[] {
  if (viewerSeat !== state.turn || state.reactionWindow !== null) return [];
  if (state.phase === "awaiting-draw") return [{ type: "game/draw" }];
  if (
    state.phase !== "awaiting-dealer-discard" &&
    state.phase !== "awaiting-discard"
  ) {
    return [];
  }
  const actions: HongKongGameCommandV1[] = playerAt(
    state.players,
    viewerSeat,
  ).hand.map((tileId) => ({ type: "game/discard", tileId }));
  actions.push(
    ...legalConcealedKongs(state, viewerSeat).map((tileIds) => ({
      type: "game/declare-concealed-kong" as const,
      tileIds,
    })),
    ...legalAddedKongs(state, viewerSeat).map(({ meldId, tileId }) => ({
      type: "game/propose-added-kong" as const,
      meldId,
      tileId,
    })),
  );
  if (scoreSelfWinCandidate(state, viewerSeat) !== null) {
    actions.push({ type: "game/declare-win" });
  }
  return actions;
}

function legalViewerReactions(
  state: CanonicalGameStateV1,
  viewerSeat: Seat,
): readonly PublicReactionAction[] {
  const actions: PublicReactionAction[] = [
    ...legalReactionsForSeat(state, viewerSeat),
  ];
  if (scoreReactionWinCandidate(state, viewerSeat) !== null) {
    actions.push({ type: "win" });
  }
  return actions;
}
