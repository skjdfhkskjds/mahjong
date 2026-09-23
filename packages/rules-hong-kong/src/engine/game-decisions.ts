import { hongKongGameEngine } from "./hong-kong-engine.js";
import type {
  GameDecisionV1,
  HongKongGameCommandV1,
  RejectedGameDecision,
} from "./game-contracts.js";
import type { CanonicalGameStateV1 } from "./game-state.js";

function rejected(code: string, message: string): RejectedGameDecision {
  return { accepted: false, error: { code, message } };
}

export function decideGameCommandV1(
  state: CanonicalGameStateV1,
  actorId: string,
  command: HongKongGameCommandV1,
): GameDecisionV1 {
  const decision = applyGameCommandV1(state, actorId, command);
  return decision.accepted
    ? { accepted: true, events: decision.events }
    : decision;
}

export function applyGameCommandV1(
  state: CanonicalGameStateV1,
  actorId: string,
  command: HongKongGameCommandV1,
): GameDecisionV1 & { readonly state?: CanonicalGameStateV1 } {
  const result = hongKongGameEngine.execute(state, actorId, command);
  return result.kind === "rejected"
    ? { accepted: false, error: result.error }
    : { accepted: true, events: result.events, state: result.state };
}

export const decideGameCommand = decideGameCommandV1;
export const applyGameCommand = applyGameCommandV1;

export function decideReactionExpiration(
  state: CanonicalGameStateV1,
): GameDecisionV1 {
  const target = hongKongGameEngine.deadlineTarget(state);
  if (target?.kind !== "reaction") {
    return rejected(
      "no-reaction-window",
      "There is no reaction window to expire.",
    );
  }
  const result = hongKongGameEngine.expire(state, { target, dueAt: 0 }, 0);
  return result.kind === "rejected"
    ? { accepted: false, error: result.error }
    : { accepted: true, events: result.events };
}
