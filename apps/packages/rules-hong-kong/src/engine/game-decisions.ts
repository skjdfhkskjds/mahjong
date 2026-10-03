import { seats } from "@mahjong/game-core";
import { decideDraw } from "./draw-decision.js";
import { hongKongGameEngine } from "./hong-kong-engine.js";
import type {
  GameDecision,
  GameDecisionV2,
  HongKongGameCommand,
  HongKongGameCommandV2,
  HongKongGameEvent,
  NonEmptyGameEventBatch,
  RejectedGameDecision,
} from "./game-contracts.js";
import { reduceGameEvent } from "./game-reducer.js";
import {
  playerAt,
  type CanonicalGameStateV1,
  type CanonicalGameStateV2,
  type CanonicalPlayerStateV1,
} from "./game-state.js";
export function decideGameCommand(
  state: CanonicalGameStateV1,
  actorId: string,
  command: HongKongGameCommand,
): GameDecision {
  const player = seats
    .map((currentSeat) => playerAt(state.players, currentSeat))
    .find((candidate) => candidate.actorId === actorId);
  if (player === undefined) {
    return rejected("spectator-cannot-play", "Only a seated player can act.");
  }
  if (state.phase === "exhausted") {
    return rejected("game-exhausted", "The wall is exhausted.");
  }
  const decision = decideLegacyCommandBatch(state, player, command);
  return decision.accepted
    ? { accepted: true, event: decision.events[0] as HongKongGameEvent }
    : decision;
}

function accepted(
  events: NonEmptyGameEventBatch,
): Extract<GameDecisionV2, { readonly accepted: true }> {
  return { accepted: true, events };
}
function rejected(code: string, message: string): RejectedGameDecision {
  return { accepted: false, error: { code, message } };
}
function decideLegacyCommandBatch(
  state: CanonicalGameStateV1,
  player: CanonicalPlayerStateV1,
  command: HongKongGameCommand,
): GameDecisionV2 {
  if (player.seat !== state.turn) {
    return rejected("not-your-turn", "Another player has the turn.");
  }
  if (command.type === "game/draw") return decideDraw(state, player.seat);
  if (
    state.phase !== "awaiting-dealer-discard" &&
    state.phase !== "awaiting-discard"
  ) {
    return rejected("discard-not-allowed", "A discard is not allowed now.");
  }
  if (!player.hand.includes(command.tileId)) {
    return rejected(
      "tile-not-in-hand",
      "That physical tile is not in the player's hand.",
    );
  }
  return accepted([
    {
      type: "game/tile-discarded",
      sequence: state.sequence + 1,
      seat: player.seat,
      tileId: command.tileId,
    },
  ]);
}
export function applyGameCommand(
  state: CanonicalGameStateV1,
  actorId: string,
  command: HongKongGameCommand,
): GameDecision & { readonly state?: CanonicalGameStateV1 } {
  const decision = decideGameCommand(state, actorId, command);
  return decision.accepted
    ? { ...decision, state: reduceGameEvent(state, decision.event) }
    : decision;
}

/** Compatibility entrypoints keep existing decisions/events while sharing live orchestration. */
export function decideGameCommandV2(
  state: CanonicalGameStateV2,
  actorId: string,
  command: HongKongGameCommandV2,
): GameDecisionV2 {
  const decision = applyGameCommandV2(state, actorId, command);
  return decision.accepted
    ? { accepted: true, events: decision.events }
    : decision;
}
export function applyGameCommandV2(
  state: CanonicalGameStateV2,
  actorId: string,
  command: HongKongGameCommandV2,
): GameDecisionV2 & { readonly state?: CanonicalGameStateV2 } {
  const result = hongKongGameEngine.execute(state, actorId, command);
  return result.kind === "rejected"
    ? { accepted: false, error: result.error }
    : { accepted: true, events: result.events, state: result.state };
}
/** Historical explicit expiry entrypoint; runtime callers use a targeted, timed engine expiry. */
export function decideReactionExpiration(
  state: CanonicalGameStateV2,
): GameDecisionV2 {
  const target = hongKongGameEngine.deadlineTarget(state);
  if (target?.kind !== "reaction")
    return rejected(
      "no-reaction-window",
      "There is no reaction window to expire.",
    );
  const result = hongKongGameEngine.expire(state, { target, dueAt: 0 }, 0);
  return result.kind === "rejected"
    ? { accepted: false, error: result.error }
    : { accepted: true, events: result.events };
}
