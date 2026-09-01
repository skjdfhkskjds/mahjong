import type { Seat } from "@mahjong/game-core";

import type {
  CanonicalGameStateV2,
  ReactionResponse,
  ReactionWindow,
} from "../engine/game-state.js";
import { playerAt } from "../engine/game-state.js";

export interface NormalizedReaction {
  readonly response: ReactionResponse;
  readonly seat: Seat;
}

export type ReactionOutcome =
  | { readonly type: "all-pass" }
  | {
      readonly type: "claim";
      readonly response: Extract<
        ReactionResponse,
        { type: "chow" | "kong" | "pung" }
      >;
      readonly seat: Seat;
    }
  | {
      readonly type: "structural-win";
      readonly seats: readonly Seat[];
    };

export interface ReactionResolution {
  readonly outcome: ReactionOutcome;
  readonly responses: readonly NormalizedReaction[];
}

export function normalizeReactionWindow(
  state: CanonicalGameStateV2,
  window: ReactionWindow,
): ReactionResolution {
  const responses = window.responderOrder.map((seat) => {
    const actorId = playerAt(state.players, seat).actorId;
    return {
      response: Object.hasOwn(window.intents, actorId)
        ? (window.intents[actorId]?.response ?? { type: "pass" as const })
        : { type: "pass" as const },
      seat,
    };
  });
  const winners = responses
    .filter(
      (
        entry,
      ): entry is NormalizedReaction & {
        readonly response: Extract<ReactionResponse, { type: "win" }>;
      } => entry.response.type === "win",
    )
    .map(({ seat }) => seat);
  if (winners.length > 0) {
    return { outcome: { type: "structural-win", seats: winners }, responses };
  }
  const pungOrKong = responses.find(
    ({ response }) => response.type === "pung" || response.type === "kong",
  );
  if (
    pungOrKong !== undefined &&
    (pungOrKong.response.type === "pung" || pungOrKong.response.type === "kong")
  ) {
    return {
      outcome: {
        type: "claim",
        response: pungOrKong.response,
        seat: pungOrKong.seat,
      },
      responses,
    };
  }
  const chow = responses.find(({ response }) => response.type === "chow");
  if (chow?.response.type === "chow") {
    return {
      outcome: { type: "claim", response: chow.response, seat: chow.seat },
      responses,
    };
  }
  return { outcome: { type: "all-pass" }, responses };
}

export function allRespondersSubmitted(
  state: CanonicalGameStateV2,
  window: ReactionWindow,
): boolean {
  return window.responderOrder.every((seat) =>
    Object.hasOwn(window.intents, playerAt(state.players, seat).actorId),
  );
}
