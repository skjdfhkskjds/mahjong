import type { CanonicalGameStateV2 } from "@mahjong/rules-hong-kong";
import { botWorkTarget } from "./table-bot-policy.js";
import {
  prepareBotWork,
  type BotJob,
  type BotWorkChanges,
} from "./table-bot-work.js";
import type { PlayerControl } from "./table-player-control.js";
import type { PresenceChanges } from "./table-presence-application.js";
import type { PersistedDeadline } from "./table-deadline-application.js";
import type { GameDeadlineChanges } from "./table-game-scheduling.js";
import { tableGameDeadline } from "./table-room-game-engine.js";

export interface ControllerSnapshot {
  readonly controls: readonly PlayerControl[];
  readonly jobs: readonly BotJob[];
}

/** Preserve player identity while handing its input to the queued bot controller. */
export function preparePlayerSubstitution(input: {
  readonly control: PlayerControl | undefined;
  readonly game: CanonicalGameStateV2 | undefined;
  readonly deadlines: readonly PersistedDeadline[];
  readonly now: number;
}):
  | {
      readonly presence: PresenceChanges;
      readonly gameDeadlines: GameDeadlineChanges;
    }
  | undefined {
  const { control } = input;
  if (control?.kind !== "HUMAN" || control.controller !== "HUMAN")
    return undefined;
  const target =
    input.game === undefined ? null : tableGameDeadline(input.game);
  return {
    presence: {
      automation: [
        {
          type: "upsert",
          automation: {
            actorId: control.actorId,
            autopilot: true,
            connectionGeneration: control.generation + 1,
          },
        },
      ],
      deadlineCancellations: [],
      deadlineReschedules: [],
      deadlineSchedules: [],
      updatedAt: input.now,
    },
    gameDeadlines: {
      cancel:
        target?.kind === "turn" && target.actorId === control.actorId
          ? input.deadlines
              .filter(
                (deadline) =>
                  deadline.status === "pending" && deadline.kind === "turn",
              )
              .map(({ deadlineId }) => deadlineId)
          : [],
      schedule: [],
    },
  };
}

/** Project already-decided presence writes for the same operation's job plan. */
export function controlsAfterPresence(
  controls: readonly PlayerControl[],
  changes: PresenceChanges | undefined,
): readonly PlayerControl[] {
  if (changes === undefined) return controls;
  const next = new Map(controls.map((control) => [control.actorId, control]));
  for (const change of changes.automation) {
    if (change.type === "delete") next.delete(change.actorId);
    else {
      const { actorId, autopilot, connectionGeneration } = change.automation;
      next.set(actorId, {
        actorId,
        kind: "HUMAN",
        controller: autopilot ? "BOT" : "HUMAN",
        generation: connectionGeneration,
      });
    }
  }
  return [...next.values()];
}

export function prepareControllerWork(input: {
  readonly controls: readonly PlayerControl[];
  readonly jobs: readonly BotJob[];
  readonly game: CanonicalGameStateV2 | undefined;
  readonly now: number;
  readonly abandoned: boolean;
  readonly createCommandId: () => string;
}): BotWorkChanges {
  return prepareBotWork({
    players: input.controls.map((control) => ({
      control,
      target:
        input.game === undefined
          ? undefined
          : botWorkTarget(input.game, control.actorId),
    })),
    jobs: input.jobs,
    now: input.now,
    abandoned: input.abandoned,
    createCommandId: input.createCommandId,
  });
}
