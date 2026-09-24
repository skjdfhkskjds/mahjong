import {
  projectGameV1,
  type CanonicalGameStateV1,
  type GameViewV1,
  type HongKongGameCommandV1,
} from "@mahjong/rules-hong-kong";

/** Policy input is a single player's projection, never canonical game state. */
export function botLegalMoves(
  view: GameViewV1,
): readonly HongKongGameCommandV1[] {
  if (view.phase === "complete" || view.phase === "exhausted") return [];
  const reaction = view.viewerActions?.reaction;
  if (reaction) {
    return reaction.status === "open"
      ? reaction.actions.map((response) => ({
          type: "game/react",
          windowId: reaction.windowId,
          response,
        }))
      : [];
  }
  return view.viewerActions?.self ?? [];
}

export function chooseBotMove(
  view: GameViewV1,
  random: number,
): HongKongGameCommandV1 | undefined {
  if (!Number.isFinite(random) || random < 0 || random >= 1)
    throw new Error("Invalid bot randomness.");
  const actions = botLegalMoves(view);
  return actions[Math.floor(random * actions.length)];
}

export function botWorkTarget(
  state: CanonicalGameStateV1,
  actorId: string,
): string | undefined {
  const view = projectGameV1(state, actorId);
  if (botLegalMoves(view).length === 0) return undefined;
  return view.reaction
    ? `reaction:${view.reaction.windowId}`
    : `turn:${String(state.sequence)}`;
}
