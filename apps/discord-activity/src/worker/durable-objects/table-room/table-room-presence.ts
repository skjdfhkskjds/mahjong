import { readStoredDeadlines, scheduleDeadline } from "./deadline-queue.js";
import { isBoundedInteger } from "./table-deadline-application.js";
import {
  preparePresenceReconciliation,
  prepareValidConnection,
  type PlayerAutomation,
  type PresenceChanges,
  type PresenceObservation,
  type PresenceState,
  type RoomLifecycle,
} from "./table-presence-application.js";

export type {
  PresenceObservation,
  RoomLifecycle,
} from "./table-presence-application.js";

export function readRoomLifecycle(sql: SqlStorage): RoomLifecycle {
  const row = sql
    .exec<{ abandoned: number; room_activity_generation: number }>(
      "SELECT abandoned, room_activity_generation FROM room_lifecycle WHERE singleton = 1",
    )
    .one();
  if (
    (row.abandoned !== 0 && row.abandoned !== 1) ||
    !isBoundedInteger(row.room_activity_generation)
  ) {
    throw new Error("Persisted room lifecycle is malformed.");
  }
  return {
    abandoned: row.abandoned === 1,
    roomActivityGeneration: row.room_activity_generation,
  };
}

function readPlayerAutomation(sql: SqlStorage): readonly PlayerAutomation[] {
  return sql
    .exec<{
      actor_id: string;
      autopilot: number;
      connection_generation: number;
    }>(
      "SELECT actor_id, autopilot, connection_generation FROM player_automation",
    )
    .toArray()
    .map((row) => {
      if (
        typeof row.actor_id !== "string" ||
        row.actor_id.length === 0 ||
        (row.autopilot !== 0 && row.autopilot !== 1) ||
        !isBoundedInteger(row.connection_generation)
      ) {
        throw new Error("Persisted player automation is malformed.");
      }
      return {
        actorId: row.actor_id,
        autopilot: row.autopilot === 1,
        connectionGeneration: row.connection_generation,
      };
    });
}

export function readAutomationByActor(
  sql: SqlStorage,
): ReadonlyMap<string, boolean> {
  return new Map(
    readPlayerAutomation(sql).map(({ actorId, autopilot }) => [
      actorId,
      autopilot,
    ]),
  );
}

export function actorIsSeated(sql: SqlStorage, actorId: string): boolean {
  return (
    sql
      .exec<{ actor_id: string }>(
        "SELECT actor_id FROM lobby_seats WHERE actor_id = ?",
        actorId,
      )
      .toArray()[0] !== undefined
  );
}

/** Read once under the caller's preparation-through-commit serialization. */
export function readPresenceState(sql: SqlStorage): PresenceState {
  return {
    tableExists:
      sql
        .exec<{ singleton: number }>(
          "SELECT singleton FROM table_record WHERE singleton = 1",
        )
        .toArray()[0] !== undefined,
    seatedActorIds: sql
      .exec<{ actor_id: string }>(
        "SELECT actor_id FROM lobby_seats WHERE actor_id NOT IN (SELECT actor_id FROM bot_players) ORDER BY CASE seat WHEN 'east' THEN 0 WHEN 'south' THEN 1 WHEN 'west' THEN 2 ELSE 3 END",
      )
      .toArray()
      .map(({ actor_id }) => actor_id),
    automation: readPlayerAutomation(sql),
    lifecycle: readRoomLifecycle(sql),
    deadlines: readStoredDeadlines(sql),
  };
}

/** Applies prepared records inside the caller's complete authority transaction. */
export function writePresenceChangesInTransaction(
  sql: SqlStorage,
  changes: PresenceChanges,
): void {
  for (const change of changes.automation) {
    if (change.type === "delete") {
      sql.exec(
        "DELETE FROM player_automation WHERE actor_id = ?",
        change.actorId,
      );
    } else {
      sql.exec(
        "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(actor_id) DO UPDATE SET connection_generation = excluded.connection_generation, autopilot = excluded.autopilot, updated_at = excluded.updated_at",
        change.automation.actorId,
        change.automation.connectionGeneration,
        Number(change.automation.autopilot),
        changes.updatedAt,
      );
    }
  }
  if (changes.lifecycle !== undefined) {
    sql.exec(
      "UPDATE room_lifecycle SET room_activity_generation = ?, abandoned = ?, updated_at = ? WHERE singleton = 1",
      changes.lifecycle.roomActivityGeneration,
      Number(changes.lifecycle.abandoned),
      changes.updatedAt,
    );
  }
  for (const deadlineId of changes.deadlineCancellations) {
    sql.exec(
      "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE deadline_id = ?",
      deadlineId,
    );
  }
  for (const deadline of changes.deadlineReschedules) {
    sql.exec(
      "UPDATE deadlines SET due_at = ? WHERE deadline_id = ?",
      deadline.dueAt,
      deadline.deadlineId,
    );
  }
  for (const deadline of changes.deadlineSchedules)
    scheduleDeadline(sql, deadline);
}

/** Compatibility wrapper; operation owners can combine the prepared changes. */
export function recordValidConnection(
  sql: SqlStorage,
  actorId: string,
  now: number,
): { readonly publicTransition: boolean; readonly seated: boolean } {
  const prepared = prepareValidConnection(readPresenceState(sql), actorId, now);
  writePresenceChangesInTransaction(sql, prepared.changes);
  return {
    publicTransition: prepared.publicTransition,
    seated: prepared.seated,
  };
}

/** Reconstructs lifecycle work using application policy and decoded storage. */
export function reconcilePresenceDeadlines(
  sql: SqlStorage,
  input: {
    readonly now: number;
    readonly observations: readonly PresenceObservation[];
  },
): void {
  writePresenceChangesInTransaction(
    sql,
    preparePresenceReconciliation(readPresenceState(sql), input),
  );
}
