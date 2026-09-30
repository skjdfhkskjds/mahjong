import type { CanonicalGameStateV1 } from "@mahjong/rules-hong-kong";

import type {
  PendingDeadline,
  PersistedDeadline,
} from "./table-deadline-application.js";
import type { PlayerControl } from "./table-player-control.js";
import { tableGameDeadline } from "./table-room-game-engine.js";

export interface GameDeadlineChanges {
  readonly cancel: readonly string[];
  readonly schedule: readonly PendingDeadline[];
}

/** Translate the engine's semantic target into application scheduling policy. */
export function prepareGameDeadlines(input: {
  readonly state: CanonicalGameStateV1;
  readonly now: number;
  readonly deadlines: readonly PersistedDeadline[];
  readonly controls: readonly PlayerControl[];
  readonly connectedActorIds: ReadonlySet<string>;
  readonly processingDeadlineId?: string;
}): GameDeadlineChanges {
  const target = tableGameDeadline(input.state);
  const control =
    target?.kind === "turn"
      ? input.controls.find(({ actorId }) => actorId === target.actorId)
      : undefined;
  let deadlineId = target?.deadlineId;
  if (target?.kind === "turn") {
    const previous = input.deadlines.find(
      (deadline) => deadline.deadlineId === deadlineId,
    );
    if (previous !== undefined && previous.status !== "pending") {
      deadlineId = `${target.deadlineId}:controller:${String(control?.generation ?? 0)}`;
    }
  }
  const cancel = input.deadlines
    .filter(
      (deadline) =>
        deadline.status === "pending" &&
        (deadline.kind === "turn" || deadline.kind === "reaction") &&
        (deadline.deadlineId !== deadlineId ||
          (target?.kind === "turn" && control?.controller === "BOT")) &&
        deadline.deadlineId !== input.processingDeadlineId,
    )
    .map(({ deadlineId }) => deadlineId);
  if (target === null || deadlineId === undefined)
    return { cancel, schedule: [] };
  if (
    target.kind === "turn" &&
    (control?.controller === "BOT" ||
      !input.connectedActorIds.has(target.actorId))
  ) {
    return { cancel, schedule: [] };
  }
  if (
    input.deadlines.some(
      (deadline) =>
        deadline.deadlineId === deadlineId && deadline.status === "pending",
    )
  ) {
    return { cancel, schedule: [] };
  }
  return {
    cancel,
    schedule: [
      {
        deadlineId,
        dueAt: input.now + (target.kind === "reaction" ? 8_000 : 60_000),
        kind: target.kind,
        payload: target.payload,
        status: "pending",
        targetGeneration: target.targetGeneration,
      },
    ],
  };
}
