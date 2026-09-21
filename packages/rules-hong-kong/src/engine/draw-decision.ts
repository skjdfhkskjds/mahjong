import type { Seat, TileId } from "@mahjong/game-core";
import { isBonusTile } from "../tiles/tile-kind-identity.js";
import type { DrawnEvent, ExhaustedEvent } from "./game-contracts.js";
import type { VersionedCanonicalGameState } from "./game-state.js";
type DrawDecision =
  | {
      readonly accepted: true;
      readonly events: readonly [DrawnEvent | ExhaustedEvent];
    }
  | {
      readonly accepted: false;
      readonly error: {
        readonly code: "draw-not-allowed";
        readonly message: string;
      };
    };
function accepted(
  events: readonly [DrawnEvent | ExhaustedEvent],
): Extract<DrawDecision, { accepted: true }> {
  return { accepted: true, events };
}
function rejected(
  code: "draw-not-allowed",
  message: string,
): Extract<DrawDecision, { accepted: false }> {
  return { accepted: false, error: { code, message } };
}
export function decideDraw(
  state: VersionedCanonicalGameState,
  currentSeat: Seat,
): DrawDecision {
  if (state.phase !== "awaiting-draw") {
    return rejected("draw-not-allowed", "A draw is not allowed in this phase.");
  }
  const ordinaryTileId = state.wall.order[state.wall.head];
  if (ordinaryTileId === undefined || state.wall.head > state.wall.tail) {
    return accepted([
      {
        type: "game/wall-exhausted",
        sequence: state.sequence + 1,
        seat: currentSeat,
        requiredDraw: "ordinary",
      },
    ]);
  }
  const replacementTileIds: TileId[] = [];
  let tail = state.wall.tail;
  if (isBonusTile(ordinaryTileId)) {
    while (tail >= state.wall.head + 1) {
      const replacement = state.wall.order[tail];
      if (replacement === undefined) break;
      replacementTileIds.push(replacement);
      tail -= 1;
      if (!isBonusTile(replacement)) break;
    }
  }
  const final = replacementTileIds.at(-1) ?? ordinaryTileId;
  return accepted([
    {
      type: "game/turn-drawn",
      sequence: state.sequence + 1,
      seat: currentSeat,
      ordinaryTileId,
      replacementTileIds,
      exhausted: isBonusTile(final),
    },
  ]);
}
