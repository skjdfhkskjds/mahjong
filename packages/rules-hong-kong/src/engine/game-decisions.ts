import { seats, type Seat, type TileId } from "@mahjong/game-core";

import {
  allRespondersSubmitted,
  normalizeReactionWindow,
} from "../claims/reaction-resolution.js";
import { isLegalReaction } from "../claims/legal-reactions.js";
import {
  concealedKongMeld,
  legalAddedKongs,
  legalConcealedKongs,
  replacementFromTail,
} from "../kongs/kong-transitions.js";
import { canonicalTileIds } from "../melds/meld.js";
import { isBonusTile } from "../tiles/tile-kind-identity.js";
import type {
  ConcealedKongDeclaredEvent,
  GameDecision,
  GameDecisionV2,
  HongKongGameCommand,
  HongKongGameCommandV2,
  HongKongGameEvent,
  NonEmptyGameEventBatch,
  ReactionIntentSubmittedEvent,
  ReactionResolvedEvent,
  RejectedGameDecision,
} from "./game-contracts.js";
import { reduceGameEvent, reduceVersionedGameEvent } from "./game-reducer.js";
import {
  isCanonicalGameStateV2,
  playerAt,
  type VersionedCanonicalGameState,
  type CanonicalGameStateV1,
  type CanonicalGameStateV2,
  type CanonicalPlayerStateV1,
  type CanonicalPlayerStateV2,
} from "./game-state.js";
import {
  expectedPendingCompletion,
  scoreReactionWinCandidate,
  scoreSelfWinCandidate,
} from "./win-resolution.js";

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

export function decideGameCommandV2(
  state: CanonicalGameStateV2,
  actorId: string,
  command: HongKongGameCommandV2,
): GameDecisionV2 {
  const player = seats
    .map((currentSeat) => playerAt(state.players, currentSeat))
    .find((candidate) => candidate.actorId === actorId);
  if (player === undefined) {
    return rejected("spectator-cannot-play", "Only a seated player can act.");
  }
  if (
    state.phase === "exhausted" ||
    state.phase === "complete" ||
    state.phase === "pending-win-validation"
  ) {
    return rejected("game-ended", "The hand has ended.");
  }
  const v2Player = playerAt(state.players, player.seat);
  if (command.type === "game/react") {
    return decideReaction(state, v2Player, command);
  }
  if (state.reactionWindow !== null) {
    return rejected(
      "reaction-in-progress",
      "The current reaction window must resolve first.",
    );
  }
  if (player.seat !== state.turn) {
    return rejected("not-your-turn", "Another player has the turn.");
  }
  if (command.type === "game/draw") return decideDraw(state, player.seat);
  if (command.type === "game/discard") {
    if (
      state.phase !== "awaiting-dealer-discard" &&
      state.phase !== "awaiting-discard"
    ) {
      return rejected("discard-not-allowed", "A discard is not allowed now.");
    }
    if (state.turnProvenance.replacementPending) {
      return rejected(
        "replacement-required",
        "A committed kong requires its replacement draw.",
      );
    }
    if (!player.hand.includes(command.tileId)) {
      return rejected(
        "tile-not-in-hand",
        "That physical tile is not in the player's hand.",
      );
    }
    const sequence = state.sequence + 1;
    return accepted([
      {
        type: "game/discard-reaction-opened",
        sequence,
        seat: player.seat,
        tileId: command.tileId,
        windowId: `discard:${String(sequence)}`,
      },
    ]);
  }
  if (command.type === "game/declare-concealed-kong") {
    const canonical = canonicalTileIds(command.tileIds);
    const legal = legalConcealedKongs(state, player.seat).some(
      (candidate) => numericIds(candidate) === numericIds(canonical),
    );
    if (!legal || numericIds(command.tileIds) !== numericIds(canonical)) {
      return rejected(
        "concealed-kong-not-allowed",
        "Those exact physical tiles cannot form a concealed kong now.",
      );
    }
    const declaredSequence = state.sequence + 1;
    const declared: ConcealedKongDeclaredEvent = {
      type: "game/concealed-kong-declared",
      sequence: declaredSequence,
      meld: concealedKongMeld(declaredSequence, command.tileIds),
      seat: player.seat,
    };
    const afterDeclared = reduceVersionedGameEvent(state, declared);
    if (!isCanonicalGameStateV2(afterDeclared)) {
      throw new Error("A v2 event produced legacy state.");
    }
    const replacement = replacementFromTail(afterDeclared);
    return accepted([
      declared,
      {
        type: "game/kong-replacement-drawn",
        sequence: declaredSequence + 1,
        exhausted: replacement.exhausted,
        seat: player.seat,
        tileIds: replacement.tileIds,
      },
    ]);
  }
  if (command.type === "game/propose-added-kong") {
    const legal = legalAddedKongs(state, player.seat).some(
      (candidate) =>
        candidate.meldId === command.meldId &&
        candidate.tileId === command.tileId,
    );
    if (!legal) {
      return rejected(
        "added-kong-not-allowed",
        "That exact pung and physical tile cannot form an added kong now.",
      );
    }
    const sequence = state.sequence + 1;
    return accepted([
      {
        type: "game/added-kong-proposed",
        sequence,
        meldId: command.meldId,
        seat: player.seat,
        tileId: command.tileId,
        windowId: `added-kong:${String(sequence)}`,
      },
    ]);
  }
  const result = scoreSelfWinCandidate(state, player.seat);
  if (result === null) {
    return rejected(
      "win-not-allowed",
      "The hand is not a legal three-faan win.",
    );
  }
  const declared = {
    type: "game/self-win-declared" as const,
    sequence: state.sequence + 1,
    seat: player.seat,
  };
  const pending = reduceVersionedGameEvent(state, declared);
  if (!isCanonicalGameStateV2(pending)) {
    throw new Error("A v2 win declaration produced legacy state.");
  }
  return accepted([
    declared,
    {
      type: "game/hand-completed",
      sequence: declared.sequence + 1,
      result: expectedPendingCompletion(pending),
    },
  ]);
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

function decideDraw(
  state: VersionedCanonicalGameState,
  currentSeat: Seat,
): GameDecisionV2 {
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

function decideReaction(
  state: CanonicalGameStateV2,
  player: CanonicalPlayerStateV2,
  command: Extract<HongKongGameCommandV2, { type: "game/react" }>,
): GameDecisionV2 {
  const window = state.reactionWindow;
  if (command.windowId !== window?.id) {
    return rejected(
      "stale-reaction-window",
      "That reaction window is not open.",
    );
  }
  if (!window.responderOrder.includes(player.seat)) {
    return rejected(
      "not-a-responder",
      "This seat cannot respond to the action.",
    );
  }
  if (Object.hasOwn(window.intents, player.actorId)) {
    return rejected("reaction-final", "The first valid response is final.");
  }
  if (command.response.type === "win") {
    if (scoreReactionWinCandidate(state, player.seat) === null) {
      return rejected(
        "win-not-allowed",
        "The claimed tile does not complete a legal three-faan win.",
      );
    }
  } else if (!isLegalReaction(state, player.seat, command.response)) {
    return rejected(
      "illegal-reaction",
      "That exact physical reaction is not legal in this window.",
    );
  }
  const intent: ReactionIntentSubmittedEvent = {
    type: "game/reaction-intent-submitted",
    sequence: state.sequence + 1,
    actorId: player.actorId,
    response:
      command.response.type === "win"
        ? { type: "win", structurallyEligible: true }
        : command.response,
    seat: player.seat,
    windowId: window.id,
  };
  const afterIntent = reduceVersionedGameEvent(state, intent);
  if (!isCanonicalGameStateV2(afterIntent)) {
    throw new Error("A v2 intent produced legacy state.");
  }
  const afterWindow = afterIntent.reactionWindow;
  if (afterWindow === null) {
    throw new Error("A reaction intent unexpectedly closed its window.");
  }
  if (!allRespondersSubmitted(afterIntent, afterWindow)) {
    return accepted([intent]);
  }
  const tail = createResolutionEvents(afterIntent);
  return accepted([intent, ...tail]);
}

export function decideReactionExpiration(
  state: CanonicalGameStateV2,
): GameDecisionV2 {
  if (
    state.reactionWindow === null ||
    (state.phase !== "awaiting-discard-reactions" &&
      state.phase !== "awaiting-added-kong-reactions")
  ) {
    return rejected(
      "no-reaction-window",
      "There is no reaction window to expire.",
    );
  }
  return accepted(createResolutionEvents(state));
}

function createResolutionEvents(
  state: CanonicalGameStateV2,
): NonEmptyGameEventBatch {
  const window = state.reactionWindow;
  if (window === null)
    throw new Error("Reaction resolution requires a window.");
  const resolution = normalizeReactionWindow(state, window);
  const resolved: ReactionResolvedEvent = {
    type: "game/reaction-resolved",
    sequence: state.sequence + 1,
    outcome: resolution.outcome,
    responses: resolution.responses,
    windowId: window.id,
  };
  const afterResolved = reduceVersionedGameEvent(state, resolved);
  if (!isCanonicalGameStateV2(afterResolved)) {
    throw new Error("A v2 resolution produced legacy state.");
  }
  if (afterResolved.phase === "pending-win-validation") {
    return [
      resolved,
      {
        type: "game/hand-completed",
        sequence: resolved.sequence + 1,
        result: expectedPendingCompletion(afterResolved),
      },
    ];
  }
  if (!afterResolved.turnProvenance.replacementPending) return [resolved];
  const replacement = replacementFromTail(afterResolved);
  return [
    resolved,
    {
      type: "game/kong-replacement-drawn",
      sequence: resolved.sequence + 1,
      exhausted: replacement.exhausted,
      seat: afterResolved.turn,
      tileIds: replacement.tileIds,
    },
  ];
}

export function applyGameCommandV2(
  state: CanonicalGameStateV2,
  actorId: string,
  command: HongKongGameCommandV2,
): GameDecisionV2 & { readonly state?: CanonicalGameStateV2 } {
  const decision = decideGameCommandV2(state, actorId, command);
  if (!decision.accepted) return decision;
  let next = state;
  for (const event of decision.events) {
    const reduced = reduceVersionedGameEvent(next, event);
    if (!isCanonicalGameStateV2(reduced)) {
      throw new Error("A schema-v2 command reduced to legacy state.");
    }
    next = reduced;
  }
  return { ...decision, state: next };
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

function numericIds(tileIds: readonly TileId[]): string {
  return tileIds.map(Number).join(",");
}
