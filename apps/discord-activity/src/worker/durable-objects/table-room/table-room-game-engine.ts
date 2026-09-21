import {
  hongKongGameEngine,
  projectGameV2,
  startHongKongV2Game,
  type CanonicalGameStateV2,
  type HongKongEngineResult,
  type NonEmptyGameEventBatch,
} from "@mahjong/rules-hong-kong";

import type {
  DeadlinePayload,
  PendingDeadline,
} from "./table-deadline-application.js";
import type { TableSeat } from "./table-room-protocol.js";

/** Ruleset selection and compatibility translation belong at composition. */
export const tableGameEngine = hongKongGameEngine;
export const startTableGame = startHongKongV2Game;
export const projectTableGame = projectGameV2;

export interface TableGameTransition {
  readonly state: CanonicalGameStateV2;
  readonly events: NonEmptyGameEventBatch;
  readonly visibility: "private" | "public";
}

type GameplayPayload = Extract<
  DeadlinePayload,
  { readonly type: "system/reaction-expired" | "system/turn-expired" }
>;

type TableGameDeadline =
  | {
      readonly kind: "reaction";
      readonly deadlineId: string;
      readonly targetGeneration: number;
      readonly payload: Extract<
        GameplayPayload,
        { readonly type: "system/reaction-expired" }
      >;
    }
  | {
      readonly kind: "turn";
      readonly actorId: string;
      readonly deadlineId: string;
      readonly targetGeneration: number;
      readonly payload: Extract<
        GameplayPayload,
        { readonly type: "system/turn-expired" }
      >;
    };

export function tableGameActorAt(
  state: CanonicalGameStateV2,
  seat: TableSeat,
): string {
  const participant = tableGameEngine
    .lifecycle(state)
    .participants.find((player) => player.seat === seat);
  if (participant === undefined)
    throw new Error("Game participant is missing.");
  return participant.actorId;
}

export function tableGamePhase(
  state: CanonicalGameStateV2,
): "playing" | "complete" | "exhausted" {
  if (tableGameEngine.lifecycle(state).phase.kind !== "finished")
    return "playing";
  return state.phase === "complete" ? "complete" : "exhausted";
}

/** Retains the schema-v4 operational payload without persisting engine internals. */
export function tableGameDeadline(
  state: CanonicalGameStateV2,
): TableGameDeadline | null {
  const target = tableGameEngine.deadlineTarget(state);
  if (target === null) return null;
  if (target.kind === "reaction") {
    return {
      kind: "reaction",
      deadlineId: `reaction:${String(target.generation)}`,
      targetGeneration: target.generation,
      payload: {
        type: "system/reaction-expired",
        openingSequence: target.generation,
        windowId: target.windowId,
      },
    };
  }
  return {
    kind: "turn",
    actorId: tableGameActorAt(state, target.seat),
    deadlineId: `turn:${String(target.generation)}`,
    targetGeneration: target.generation,
    payload: {
      type: "system/turn-expired",
      openingSequence: target.generation,
      phase: target.stage,
      seat: target.seat,
    },
  };
}

export function tableGameDeadlineMatches(
  state: CanonicalGameStateV2,
  payload: GameplayPayload,
): boolean {
  const target = tableGameEngine.deadlineTarget(state);
  if (target?.generation !== payload.openingSequence) return false;
  switch (payload.type) {
    case "system/reaction-expired":
      return target.kind === "reaction" && target.windowId === payload.windowId;
    case "system/turn-expired":
      return (
        target.kind === "turn" &&
        target.stage === payload.phase &&
        target.seat === payload.seat
      );
  }
}

export function expireTableGame(
  state: CanonicalGameStateV2,
  deadline: PendingDeadline,
  now: number,
): HongKongEngineResult {
  const payload = deadline.payload;
  if (
    (payload.type !== "system/reaction-expired" &&
      payload.type !== "system/turn-expired") ||
    !tableGameDeadlineMatches(state, payload)
  ) {
    return {
      kind: "rejected",
      error: {
        code: "stale-expiry",
        message: "The game deadline is no longer current.",
      },
    };
  }
  const target = tableGameEngine.deadlineTarget(state);
  if (target === null) throw new Error("Current game deadline has no target.");
  return tableGameEngine.expire(state, { target, dueAt: deadline.dueAt }, now);
}
