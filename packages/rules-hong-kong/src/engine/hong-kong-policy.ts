import {
  seats,
  type FlowTransition,
  type GameLifecycle,
  type GameParticipant,
  type GamePolicy,
  type TileId,
} from "@mahjong/game-core";

import { normalizeReactionWindow } from "../claims/reaction-resolution.js";
import { isLegalReaction } from "../claims/legal-reactions.js";
import {
  concealedKongMeld,
  legalAddedKongs,
  legalConcealedKongs,
  replacementFromTail,
} from "../kongs/kong-transitions.js";
import { canonicalTileIds } from "../melds/meld.js";
import { decideDraw } from "./draw-decision.js";
import type {
  ConcealedKongDeclaredEvent,
  HongKongGameCommandV2,
  KongReplacementDrawnEvent,
  ReactionIntentSubmittedEvent,
  ReactionResolvedEvent,
  VersionedHongKongGameEvent,
} from "./game-contracts.js";
import { reduceVersionedGameEvent } from "./game-reducer.js";
import { playerAt, type CanonicalGameStateV2 } from "./game-state.js";
import type {
  HongKongMoveError,
  HongKongMoveOutcome,
  HongKongResolution,
  HongKongSubmission,
  HongKongTurnStage,
  KongReplacement,
} from "./hong-kong-policy-outcomes.js";
import {
  expectedPendingCompletion,
  scoreReactionWinCandidate,
  scoreSelfWinCandidate,
} from "./win-resolution.js";

export type HongKongPolicy = GamePolicy<
  CanonicalGameStateV2,
  HongKongGameCommandV2,
  VersionedHongKongGameEvent,
  HongKongTurnStage,
  HongKongMoveOutcome,
  HongKongSubmission,
  HongKongResolution,
  HongKongMoveError
>;

type MoveDecision = ReturnType<HongKongPolicy["evaluate"]>;
type ResolutionDecision = ReturnType<HongKongPolicy["resolve"]>;

export const hongKongPolicy: HongKongPolicy = {
  readLifecycle,
  classify: (command) =>
    command.type === "game/react"
      ? { kind: "reaction", windowId: command.windowId }
      : { kind: "turn" },
  evaluate,
  resolve,
  reduce,
  automaticMove,
};

function reduce(
  state: CanonicalGameStateV2,
  event: VersionedHongKongGameEvent,
): CanonicalGameStateV2 {
  const next = reduceVersionedGameEvent(state, event);
  if (next.schemaVersion !== 2)
    throw new Error("A live game reduced to historical state.");
  return next;
}

function readLifecycle(
  state: CanonicalGameStateV2,
): GameLifecycle<HongKongTurnStage> {
  const base = {
    participants: seats.map((seat) => ({
      actorId: playerAt(state.players, seat).actorId,
      seat,
    })),
    activeSeat: state.turn,
  };
  switch (state.phase) {
    case "awaiting-dealer-discard":
    case "awaiting-draw":
    case "awaiting-discard":
      return {
        ...base,
        phase: { kind: "turn", stage: state.phase, generation: state.sequence },
      };
    case "awaiting-discard-reactions":
    case "awaiting-added-kong-reactions": {
      const window = state.reactionWindow;
      if (window === null)
        throw new Error("Reaction phase lacks its canonical window.");
      return {
        ...base,
        phase: {
          kind: "reaction",
          window: {
            id: window.id,
            generation: window.openingSequence,
            responders: window.responderOrder,
            submitted: window.responderOrder
              .map((seat) => playerAt(state.players, seat).actorId)
              .filter((actorId) => Object.hasOwn(window.intents, actorId)),
          },
        },
      };
    }
    case "complete":
    case "exhausted":
    case "pending-win-validation":
      return { ...base, phase: { kind: "finished" } };
  }
}

function rejected(code: HongKongMoveError, message: string): MoveDecision {
  return { kind: "rejected", error: { code, message } };
}

function evaluate(
  state: CanonicalGameStateV2,
  participant: GameParticipant,
  command: HongKongGameCommandV2,
): MoveDecision {
  const player = playerAt(state.players, participant.seat);
  switch (command.type) {
    case "game/react": {
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
        windowId: command.windowId,
      };
      return {
        kind: "pending",
        events: [intent],
        submission: { seat: player.seat, response: command.response },
        windowId: command.windowId,
      };
    }
    case "game/draw": {
      const decision = decideDraw(state, player.seat);
      if (!decision.accepted)
        return { kind: "rejected", error: decision.error };
      const drawn = decision.events[0];
      if (drawn.type === "game/wall-exhausted") {
        return {
          kind: "applied",
          events: [drawn],
          outcome: { kind: "exhausted", requiredDraw: "ordinary" },
          transition: { kind: "finished", seat: player.seat },
        };
      }
      return {
        kind: "applied",
        events: [drawn],
        outcome: drawn.exhausted
          ? { kind: "exhausted", requiredDraw: "bonus-replacement" }
          : {
              kind: "drawn",
              ordinaryTileId: drawn.ordinaryTileId,
              replacementTileIds: drawn.replacementTileIds,
            },
        transition: drawn.exhausted
          ? { kind: "finished", seat: player.seat }
          : turn(drawn.sequence, { kind: "retain" }),
      };
    }
    case "game/discard": {
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
      const windowId = `discard:${String(sequence)}`;
      return {
        kind: "applied",
        events: [
          {
            type: "game/discard-reaction-opened",
            sequence,
            seat: player.seat,
            tileId: command.tileId,
            windowId,
          },
        ],
        outcome: { kind: "discarded", tileId: command.tileId, windowId },
        transition: {
          kind: "reaction",
          windowId,
          generation: sequence,
          sourceSeat: player.seat,
          active: "next",
        },
      };
    }
    case "game/declare-concealed-kong": {
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
      const sequence = state.sequence + 1;
      const declared: ConcealedKongDeclaredEvent = {
        type: "game/concealed-kong-declared",
        sequence,
        meld: concealedKongMeld(sequence, command.tileIds),
        seat: player.seat,
      };
      const afterDeclared = reduce(state, declared);
      const replacement = kongReplacement(afterDeclared);
      return {
        kind: "applied",
        events: [declared, replacement.event],
        outcome: {
          kind: "concealed-kong",
          meld: declared.meld,
          replacement: replacement.outcome,
        },
        transition: replacement.event.exhausted
          ? { kind: "finished", seat: player.seat }
          : turn(
              replacement.event.sequence,
              { kind: "retain" },
              state.phase === "awaiting-dealer-discard"
                ? state.phase
                : "awaiting-discard",
            ),
      };
    }
    case "game/propose-added-kong": {
      if (
        !legalAddedKongs(state, player.seat).some(
          (candidate) =>
            candidate.meldId === command.meldId &&
            candidate.tileId === command.tileId,
        )
      ) {
        return rejected(
          "added-kong-not-allowed",
          "That exact pung and physical tile cannot form an added kong now.",
        );
      }
      const sequence = state.sequence + 1;
      const windowId = `added-kong:${String(sequence)}`;
      return {
        kind: "applied",
        events: [
          {
            type: "game/added-kong-proposed",
            sequence,
            meldId: command.meldId,
            seat: player.seat,
            tileId: command.tileId,
            windowId,
          },
        ],
        outcome: {
          kind: "added-kong-proposed",
          meldId: command.meldId,
          tileId: command.tileId,
          windowId,
        },
        transition: {
          kind: "reaction",
          windowId,
          generation: sequence,
          sourceSeat: player.seat,
          active: "source",
        },
      };
    }
    case "game/declare-win": {
      const result = scoreSelfWinCandidate(state, player.seat);
      if (result === null)
        return rejected(
          "win-not-allowed",
          "The hand is not a legal three-faan win.",
        );
      return {
        kind: "completed",
        events: [
          {
            type: "game/self-win-declared",
            sequence: state.sequence + 1,
            seat: player.seat,
          },
          { type: "game/hand-completed", sequence: state.sequence + 2, result },
        ],
        result: { kind: "self-win", result },
        transition: { kind: "finished", seat: player.seat },
      };
    }
  }
}

function resolve(state: CanonicalGameStateV2): ResolutionDecision {
  const window = state.reactionWindow;
  if (window === null)
    throw new Error("Policy resolution requires an open window.");
  const normalized = normalizeReactionWindow(state, window);
  const resolved: ReactionResolvedEvent = {
    type: "game/reaction-resolved",
    sequence: state.sequence + 1,
    outcome: normalized.outcome,
    responses: normalized.responses,
    windowId: window.id,
  };
  const afterResolved = reduce(state, resolved);
  if (normalized.outcome.type === "structural-win") {
    const result = expectedPendingCompletion(afterResolved);
    return {
      events: [
        resolved,
        {
          type: "game/hand-completed",
          sequence: resolved.sequence + 1,
          result,
        },
      ],
      result: {
        kind: "reaction",
        windowId: window.id,
        outcome: {
          kind: "hand-won",
          result,
          claimants: normalized.outcome.seats.map((seat) => ({
            seat,
            award: seat === result.winnerSeat ? "awarded" : "not-awarded",
          })),
        },
      },
      transition: { kind: "finished", seat: result.winnerSeat },
    };
  }
  if (window.kind === "added-kong") {
    const replacement = kongReplacement(afterResolved);
    return {
      events: [resolved, replacement.event],
      result: {
        kind: "reaction",
        windowId: window.id,
        outcome: {
          kind: "added-kong-completed",
          seat: window.sourceSeat,
          replacement: replacement.outcome,
        },
      },
      transition: replacement.event.exhausted
        ? { kind: "finished", seat: window.sourceSeat }
        : turn(replacement.event.sequence, {
            kind: "select",
            seat: window.sourceSeat,
          }),
    };
  }
  if (normalized.outcome.type === "all-pass") {
    return {
      events: [resolved],
      result: {
        kind: "reaction",
        windowId: window.id,
        outcome: { kind: "all-pass" },
      },
      transition: turn(
        resolved.sequence,
        { kind: "advance", from: window.sourceSeat },
        "awaiting-draw",
      ),
    };
  }
  const claim = normalized.outcome;
  if (claim.response.type === "kong") {
    const replacement = kongReplacement(afterResolved);
    return {
      events: [resolved, replacement.event],
      result: {
        kind: "reaction",
        windowId: window.id,
        outcome: {
          kind: "kong-claimed",
          seat: claim.seat,
          response: claim.response,
          replacement: replacement.outcome,
        },
      },
      transition: replacement.event.exhausted
        ? { kind: "finished", seat: claim.seat }
        : turn(replacement.event.sequence, {
            kind: "select",
            seat: claim.seat,
          }),
    };
  }
  return {
    events: [resolved],
    result: {
      kind: "reaction",
      windowId: window.id,
      outcome: {
        kind: "meld-claimed",
        seat: claim.seat,
        response: claim.response,
      },
    },
    transition: turn(resolved.sequence, { kind: "select", seat: claim.seat }),
  };
}

function turn(
  generation: number,
  next: Extract<FlowTransition<HongKongTurnStage>, { kind: "turn" }>["next"],
  stage: HongKongTurnStage = "awaiting-discard",
): Extract<FlowTransition<HongKongTurnStage>, { kind: "turn" }> {
  return { kind: "turn", generation, next, stage };
}

function kongReplacement(state: CanonicalGameStateV2): {
  readonly event: KongReplacementDrawnEvent;
  readonly outcome: KongReplacement;
} {
  const replacement = replacementFromTail(state);
  return {
    event: {
      type: "game/kong-replacement-drawn",
      sequence: state.sequence + 1,
      seat: state.turn,
      exhausted: replacement.exhausted,
      tileIds: replacement.tileIds,
    },
    outcome: replacement.exhausted
      ? { kind: "exhausted", tileIds: replacement.tileIds }
      : { kind: "drawn", tileIds: replacement.tileIds },
  };
}

function automaticMove(
  state: CanonicalGameStateV2,
  participant: GameParticipant,
): HongKongGameCommandV2 | null {
  if (state.reactionWindow !== null) {
    return {
      type: "game/react",
      response: { type: "pass" },
      windowId: state.reactionWindow.id,
    };
  }
  if (state.phase === "awaiting-draw") return { type: "game/draw" };
  if (
    state.phase !== "awaiting-dealer-discard" &&
    state.phase !== "awaiting-discard"
  )
    return null;
  const player = playerAt(state.players, participant.seat);
  const acquired = state.turnProvenance.lastAcquiredTileId;
  const tileId =
    acquired !== null && player.hand.includes(acquired)
      ? acquired
      : [...player.hand].sort((a, b) => a - b)[0];
  if (tileId === undefined)
    throw new Error("An automatic discard requires a concealed tile.");
  return { type: "game/discard", tileId };
}

function numericIds(tileIds: readonly TileId[]): string {
  return tileIds.map(Number).join(",");
}
