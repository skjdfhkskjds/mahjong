import { scheduleDeadline } from "./deadline-queue.js";

const DISCONNECT_GRACE_MS = 15_000;
const ABANDONMENT_DEADLINE_MS = 15 * 60_000;

export interface PresenceObservation {
  readonly actorId: string;
  /** The instant this otherwise-current grant stops representing presence. */
  readonly expiresAt: number;
}

export interface RoomLifecycle {
  readonly abandoned: boolean;
  readonly roomActivityGeneration: number;
}

function reconcileDerivedDeadline(
  sql: SqlStorage,
  deadline: Parameters<typeof scheduleDeadline>[1],
  targetsPayload: (payload: Record<string, unknown>) => boolean,
  preserveEarlierPending: boolean,
): void {
  const rows = sql
    .exec<{
      deadline_id: string;
      due_at: number;
      payload_json: string;
      status: string;
    }>(
      "SELECT deadline_id, due_at, payload_json, status FROM deadlines WHERE kind = ? AND target_generation = ?",
      deadline.kind,
      deadline.targetGeneration,
    )
    .toArray();
  const matching = rows.filter((row) => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    return targetsPayload(payload);
  });
  let deadlineId = deadline.deadlineId;
  let dueAt = deadline.dueAt;
  const earlierPending = preserveEarlierPending
    ? matching
        .filter((row) => row.status === "pending" && row.due_at <= dueAt)
        .sort(
          (left, right) =>
            left.due_at - right.due_at ||
            left.deadline_id.localeCompare(right.deadline_id),
        )[0]
    : undefined;
  if (earlierPending !== undefined) {
    deadlineId = earlierPending.deadline_id;
    dueAt = earlierPending.due_at;
  }
  const exact = matching.find((row) => row.deadline_id === deadlineId);
  if (exact !== undefined && exact.status !== "pending") {
    const root = `${deadlineId}:r${String(dueAt)}`;
    deadlineId = root;
    let suffix = 0;
    while (
      matching.some(
        (row) => row.deadline_id === deadlineId && row.status !== "pending",
      )
    ) {
      suffix += 1;
      deadlineId = `${root}:${String(suffix)}`;
    }
  }
  for (const row of matching) {
    if (row.status === "pending" && row.deadline_id !== deadlineId) {
      sql.exec(
        "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE deadline_id = ? AND status = 'pending'",
        row.deadline_id,
      );
    }
  }
  const pending = matching.find(
    (row) => row.deadline_id === deadlineId && row.status === "pending",
  );
  if (pending !== undefined) {
    sql.exec(
      "UPDATE deadlines SET due_at = ? WHERE deadline_id = ? AND status = 'pending'",
      dueAt,
      deadlineId,
    );
  } else {
    scheduleDeadline(sql, { ...deadline, deadlineId, dueAt });
  }
}

export function readRoomLifecycle(sql: SqlStorage): RoomLifecycle {
  const row = sql
    .exec<{ abandoned: number; room_activity_generation: number }>(
      "SELECT abandoned, room_activity_generation FROM room_lifecycle WHERE singleton = 1",
    )
    .one();
  return {
    abandoned: row.abandoned === 1,
    roomActivityGeneration: row.room_activity_generation,
  };
}

export function readAutomationByActor(
  sql: SqlStorage,
): ReadonlyMap<string, boolean> {
  return new Map(
    sql
      .exec<{ actor_id: string; autopilot: number }>(
        "SELECT actor_id, autopilot FROM player_automation",
      )
      .toArray()
      .map((row) => [row.actor_id, row.autopilot === 1]),
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

/**
 * Records real room activity. Spectators keep a live room from becoming newly
 * abandoned, but only a seated player may recover an already-abandoned table.
 */
export function recordValidConnection(
  sql: SqlStorage,
  actorId: string,
  now: number,
): { readonly publicTransition: boolean; readonly seated: boolean } {
  const seated = actorIsSeated(sql, actorId);
  const lifecycle = readRoomLifecycle(sql);
  let priorAutopilot = false;
  if (seated) {
    const prior = sql
      .exec<{ autopilot: number }>(
        "SELECT autopilot FROM player_automation WHERE actor_id = ?",
        actorId,
      )
      .toArray()[0];
    priorAutopilot = prior?.autopilot === 1;
    const nextGeneration = sql
      .exec<{ generation: number }>(
        "SELECT COALESCE(MAX(connection_generation), 0) + 1 AS generation FROM player_automation",
      )
      .one().generation;
    sql.exec(
      "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(actor_id) DO UPDATE SET connection_generation = excluded.connection_generation, autopilot = 0, updated_at = excluded.updated_at",
      actorId,
      nextGeneration,
      now,
    );
  }
  sql.exec(
    "UPDATE room_lifecycle SET room_activity_generation = room_activity_generation + 1, abandoned = CASE WHEN ? = 1 THEN 0 ELSE abandoned END, updated_at = ? WHERE singleton = 1",
    Number(seated),
    now,
  );
  return {
    publicTransition: priorAutopilot || (seated && lifecycle.abandoned),
    seated,
  };
}

function seatedActors(sql: SqlStorage): readonly string[] {
  return sql
    .exec<{ actor_id: string }>(
      "SELECT actor_id FROM lobby_seats ORDER BY CASE seat WHEN 'east' THEN 0 WHEN 'south' THEN 1 WHEN 'west' THEN 2 ELSE 3 END",
    )
    .toArray()
    .map(({ actor_id }) => actor_id);
}

/**
 * Rebuilds recoverable lifecycle work from authoritative seats, the canonical
 * game, and hibernating socket attachments. This is safe after v3 migration,
 * eviction, or a silently expired grant.
 */
export function reconcilePresenceDeadlines(
  sql: SqlStorage,
  input: {
    readonly now: number;
    readonly observations: readonly PresenceObservation[];
  },
): void {
  if (
    sql
      .exec<{ singleton: number }>(
        "SELECT singleton FROM table_record WHERE singleton = 1",
      )
      .toArray()[0] === undefined
  ) {
    return;
  }
  const actorIds = seatedActors(sql);
  const seated = new Set(actorIds);
  const retiredActors = sql
    .exec<{ actor_id: string }>("SELECT actor_id FROM player_automation")
    .toArray()
    .map(({ actor_id }) => actor_id)
    .filter((actorId) => !seated.has(actorId));
  if (retiredActors.length > 0) {
    for (const row of sql
      .exec<{ deadline_id: string; payload_json: string }>(
        "SELECT deadline_id, payload_json FROM deadlines WHERE kind = 'disconnect' AND status = 'pending'",
      )
      .toArray()) {
      const payload = JSON.parse(row.payload_json) as {
        readonly actorId?: unknown;
      };
      if (
        typeof payload.actorId === "string" &&
        retiredActors.includes(payload.actorId)
      ) {
        sql.exec(
          "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE deadline_id = ? AND status = 'pending'",
          row.deadline_id,
        );
      }
    }
    for (const actorId of retiredActors) {
      sql.exec("DELETE FROM player_automation WHERE actor_id = ?", actorId);
    }
  }
  let nextGeneration = sql
    .exec<{ generation: number }>(
      "SELECT COALESCE(MAX(connection_generation), 0) + 1 AS generation FROM player_automation",
    )
    .one().generation;
  for (const actorId of actorIds) {
    const existing = sql
      .exec<{ actor_id: string }>(
        "SELECT actor_id FROM player_automation WHERE actor_id = ?",
        actorId,
      )
      .toArray()[0];
    if (existing === undefined) {
      sql.exec(
        "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES (?, ?, 0, ?)",
        actorId,
        nextGeneration,
        input.now,
      );
      nextGeneration += 1;
    }
  }

  for (const actorId of actorIds) {
    const automation = sql
      .exec<{ autopilot: number; connection_generation: number }>(
        "SELECT autopilot, connection_generation FROM player_automation WHERE actor_id = ?",
        actorId,
      )
      .one();
    if (automation.autopilot === 1) continue;
    const expiries = input.observations
      .filter((observation) => observation.actorId === actorId)
      .map(({ expiresAt }) => expiresAt);
    const latestExpiry =
      expiries.length === 0 ? undefined : Math.max(...expiries);
    const expiryBacked = latestExpiry !== undefined;
    const deadlineId = `${expiryBacked ? "disconnect-expiry" : "disconnect"}:${String(automation.connection_generation)}`;
    reconcileDerivedDeadline(
      sql,
      {
        deadlineId,
        dueAt: (latestExpiry ?? input.now) + DISCONNECT_GRACE_MS,
        kind: "disconnect",
        payload: {
          type: "system/disconnect-grace-expired",
          actorId,
          connectionGeneration: automation.connection_generation,
        },
        status: "pending",
        targetGeneration: automation.connection_generation,
      },
      (payload) => payload["actorId"] === actorId,
      !expiryBacked,
    );
  }

  const lifecycle = readRoomLifecycle(sql);
  if (lifecycle.abandoned) return;
  const latestRoomExpiry =
    input.observations.length === 0
      ? undefined
      : Math.max(...input.observations.map(({ expiresAt }) => expiresAt));
  const expiryBacked = latestRoomExpiry !== undefined;
  reconcileDerivedDeadline(
    sql,
    {
      deadlineId: `${expiryBacked ? "abandonment-expiry" : "abandonment"}:${String(lifecycle.roomActivityGeneration)}`,
      dueAt: (latestRoomExpiry ?? input.now) + ABANDONMENT_DEADLINE_MS,
      kind: "abandonment",
      payload: {
        type: "system/table-abandonment-expired",
        roomActivityGeneration: lifecycle.roomActivityGeneration,
      },
      status: "pending",
      targetGeneration: lifecycle.roomActivityGeneration,
    },
    (payload) =>
      payload["roomActivityGeneration"] === lifecycle.roomActivityGeneration,
    !expiryBacked,
  );
}
