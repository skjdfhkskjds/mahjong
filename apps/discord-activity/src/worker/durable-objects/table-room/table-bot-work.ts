import type { PlayerControl } from "./table-player-control.js";

export const BOT_MOVE_DELAY_MS = 750;

export interface BotJob {
  readonly actorId: string;
  readonly target: string;
  readonly commandId: string;
  readonly dueAt: number;
  readonly controllerGeneration: number;
}

export interface BotWorkChanges {
  readonly cancelActorIds: readonly string[];
  readonly upsert: readonly BotJob[];
}

/** A target exists only when this player's permitted view offers a move. */
export interface BotWorkPlayer {
  readonly control: PlayerControl;
  readonly target: string | undefined;
}

/** Pure scheduling policy; its changes commit with the operation that caused them. */
export function prepareBotWork(input: {
  readonly players: readonly BotWorkPlayer[];
  readonly jobs: readonly BotJob[];
  readonly now: number;
  readonly abandoned: boolean;
  readonly createCommandId: () => string;
}): BotWorkChanges {
  const desired = new Map(
    input.players
      .filter(
        ({ control, target }) =>
          !input.abandoned &&
          control.controller === "BOT" &&
          target !== undefined,
      )
      .map((player) => [player.control.actorId, player]),
  );
  const cancelActorIds = input.jobs
    .filter((job) => !desired.has(job.actorId))
    .map(({ actorId }) => actorId);
  const upsert: BotJob[] = [];
  for (const { control, target } of desired.values()) {
    if (target === undefined) continue;
    const existing = input.jobs.find(
      ({ actorId }) => actorId === control.actorId,
    );
    if (
      existing?.target === target &&
      existing.controllerGeneration === control.generation
    )
      continue;
    upsert.push({
      actorId: control.actorId,
      target,
      commandId: input.createCommandId(),
      dueAt: input.now + BOT_MOVE_DELAY_MS,
      controllerGeneration: control.generation,
    });
  }
  return { cancelActorIds, upsert };
}
