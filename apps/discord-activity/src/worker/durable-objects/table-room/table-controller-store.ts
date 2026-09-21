import type { BotWorkChanges } from "./table-bot-work.js";
import type { ControllerSnapshot } from "./table-controller-application.js";
import { readBotWork, readPlayerControls } from "./table-room-bots.js";

export function readControllerSnapshot(sql: SqlStorage): ControllerSnapshot {
  return {
    controls: readPlayerControls(sql),
    jobs: readBotWork(sql).map((job) => ({
      actorId: job.actor_id,
      target: job.target,
      commandId: job.command_id,
      dueAt: job.due_at,
      controllerGeneration: job.controller_generation,
    })),
  };
}

/** Part of the enclosing operation, never an independently committed workflow. */
export function writeControllerWorkInTransaction(
  sql: SqlStorage,
  changes: BotWorkChanges,
): void {
  for (const actorId of changes.cancelActorIds)
    sql.exec("DELETE FROM bot_work WHERE actor_id = ?", actorId);
  for (const job of changes.upsert)
    sql.exec(
      "INSERT INTO bot_work (actor_id, target, command_id, due_at, controller_generation) VALUES (?, ?, ?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET target = excluded.target, command_id = excluded.command_id, due_at = excluded.due_at, controller_generation = excluded.controller_generation",
      job.actorId,
      job.target,
      job.commandId,
      job.dueAt,
      job.controllerGeneration,
    );
}
