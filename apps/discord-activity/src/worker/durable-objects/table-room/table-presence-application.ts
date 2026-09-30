import type {
  PendingDeadline,
  PersistedDeadline,
} from "./table-deadline-application.js";

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

export interface PlayerAutomation {
  readonly actorId: string;
  readonly autopilot: boolean;
  readonly connectionGeneration: number;
}

export interface PresenceState {
  readonly tableExists: boolean;
  readonly seatedActorIds: readonly string[];
  readonly automation: readonly PlayerAutomation[];
  readonly lifecycle: RoomLifecycle;
  readonly deadlines: readonly PersistedDeadline[];
}

export type PresenceAutomationChange =
  | { readonly type: "delete"; readonly actorId: string }
  | { readonly type: "upsert"; readonly automation: PlayerAutomation };

/** All changes participate in their enclosing authority operation's commit. */
export interface PresenceChanges {
  readonly automation: readonly PresenceAutomationChange[];
  readonly deadlineCancellations: readonly string[];
  readonly deadlineReschedules: readonly {
    readonly deadlineId: string;
    readonly dueAt: number;
  }[];
  readonly deadlineSchedules: readonly PendingDeadline[];
  readonly lifecycle?: RoomLifecycle;
  readonly updatedAt: number;
}

export interface PreparedValidConnection {
  readonly changes: PresenceChanges;
  readonly publicTransition: boolean;
  readonly seated: boolean;
}

function nextConnectionGeneration(
  automation: readonly PlayerAutomation[],
): number {
  return (
    Math.max(
      0,
      ...automation.map(({ connectionGeneration }) => connectionGeneration),
    ) + 1
  );
}

/**
 * Spectators renew room activity. Only a seated player's valid connection
 * recovers abandonment or switches that actor out of disconnected autopilot.
 */
export function prepareValidConnection(
  state: PresenceState,
  actorId: string,
  now: number,
): PreparedValidConnection {
  const seated = state.seatedActorIds.includes(actorId);
  const priorAutopilot =
    seated &&
    state.automation.some(
      (automation) => automation.actorId === actorId && automation.autopilot,
    );
  return {
    publicTransition: priorAutopilot || (seated && state.lifecycle.abandoned),
    seated,
    changes: {
      automation: seated
        ? [
            {
              type: "upsert",
              automation: {
                actorId,
                autopilot: false,
                connectionGeneration: nextConnectionGeneration(
                  state.automation,
                ),
              },
            },
          ]
        : [],
      deadlineCancellations: [],
      deadlineReschedules: [],
      deadlineSchedules: [],
      lifecycle: {
        abandoned: seated ? false : state.lifecycle.abandoned,
        roomActivityGeneration: state.lifecycle.roomActivityGeneration + 1,
      },
      updatedAt: now,
    },
  };
}

interface DerivedDeadlineChanges {
  readonly cancellations: readonly string[];
  readonly reschedules: readonly {
    readonly deadlineId: string;
    readonly dueAt: number;
  }[];
  readonly schedules: readonly PendingDeadline[];
}

function prepareDerivedDeadline(
  deadlines: readonly PersistedDeadline[],
  deadline: PendingDeadline,
  targetsPayload: (deadline: PersistedDeadline) => boolean,
  preserveEarlierPending: boolean,
): DerivedDeadlineChanges {
  const matching = deadlines.filter(
    (stored) =>
      stored.kind === deadline.kind &&
      stored.targetGeneration === deadline.targetGeneration &&
      targetsPayload(stored),
  );
  let deadlineId = deadline.deadlineId;
  let dueAt = deadline.dueAt;
  const earlierPending = preserveEarlierPending
    ? matching
        .filter(
          (stored) => stored.status === "pending" && stored.dueAt <= dueAt,
        )
        .sort(
          (left, right) =>
            left.dueAt - right.dueAt ||
            left.deadlineId.localeCompare(right.deadlineId),
        )[0]
    : undefined;
  if (earlierPending !== undefined) {
    deadlineId = earlierPending.deadlineId;
    dueAt = earlierPending.dueAt;
  }
  const exact = matching.find((stored) => stored.deadlineId === deadlineId);
  if (exact !== undefined && exact.status !== "pending") {
    const root = `${deadlineId}:r${String(dueAt)}`;
    deadlineId = root;
    let suffix = 0;
    while (
      matching.some(
        (stored) =>
          stored.deadlineId === deadlineId && stored.status !== "pending",
      )
    ) {
      suffix += 1;
      deadlineId = `${root}:${String(suffix)}`;
    }
  }
  const cancellations = matching
    .filter(
      (stored) =>
        stored.status === "pending" && stored.deadlineId !== deadlineId,
    )
    .map(({ deadlineId }) => deadlineId);
  const pending = matching.some(
    (stored) => stored.deadlineId === deadlineId && stored.status === "pending",
  );
  return {
    cancellations,
    reschedules: pending ? [{ deadlineId, dueAt }] : [],
    schedules: pending ? [] : [{ ...deadline, deadlineId, dueAt }],
  };
}

/** Reconstructs recoverable work without changing grace or controller policy. */
export function preparePresenceReconciliation(
  state: PresenceState,
  input: {
    readonly now: number;
    readonly observations: readonly PresenceObservation[];
  },
): PresenceChanges {
  const automation: PresenceAutomationChange[] = [];
  const deadlineCancellations: string[] = [];
  const deadlineReschedules: {
    readonly deadlineId: string;
    readonly dueAt: number;
  }[] = [];
  const deadlineSchedules: PendingDeadline[] = [];
  const changes: PresenceChanges = {
    automation,
    deadlineCancellations,
    deadlineReschedules,
    deadlineSchedules,
    updatedAt: input.now,
  };
  if (!state.tableExists) return changes;

  const seated = new Set(state.seatedActorIds);
  const retiredActors = new Set(
    state.automation
      .filter(({ actorId }) => !seated.has(actorId))
      .map(({ actorId }) => actorId),
  );
  for (const deadline of state.deadlines) {
    if (
      deadline.status === "pending" &&
      deadline.payload.type === "system/disconnect-grace-expired" &&
      retiredActors.has(deadline.payload.actorId)
    ) {
      deadlineCancellations.push(deadline.deadlineId);
    }
  }
  for (const actorId of retiredActors)
    automation.push({ type: "delete", actorId });
  const currentAutomation = state.automation.filter(({ actorId }) =>
    seated.has(actorId),
  );
  let nextGeneration = nextConnectionGeneration(currentAutomation);
  for (const actorId of state.seatedActorIds) {
    if (!currentAutomation.some((entry) => entry.actorId === actorId)) {
      const added = {
        actorId,
        autopilot: false,
        connectionGeneration: nextGeneration,
      };
      currentAutomation.push(added);
      automation.push({ type: "upsert", automation: added });
      nextGeneration += 1;
    }
  }

  const appendDerivedChanges = (derived: DerivedDeadlineChanges): void => {
    deadlineCancellations.push(...derived.cancellations);
    deadlineReschedules.push(...derived.reschedules);
    deadlineSchedules.push(...derived.schedules);
  };
  for (const actorId of state.seatedActorIds) {
    const player = currentAutomation.find((entry) => entry.actorId === actorId);
    if (player === undefined)
      throw new Error("Seated actor automation is missing.");
    if (player.autopilot) continue;
    const expiries = input.observations
      .filter((observation) => observation.actorId === actorId)
      .map(({ expiresAt }) => expiresAt);
    const latestExpiry =
      expiries.length === 0 ? undefined : Math.max(...expiries);
    const expiryBacked = latestExpiry !== undefined;
    appendDerivedChanges(
      prepareDerivedDeadline(
        state.deadlines,
        {
          deadlineId: `${expiryBacked ? "disconnect-expiry" : "disconnect"}:${String(player.connectionGeneration)}`,
          dueAt: (latestExpiry ?? input.now) + DISCONNECT_GRACE_MS,
          kind: "disconnect",
          payload: {
            type: "system/disconnect-grace-expired",
            actorId,
            connectionGeneration: player.connectionGeneration,
          },
          status: "pending",
          targetGeneration: player.connectionGeneration,
        },
        (deadline) =>
          deadline.payload.type === "system/disconnect-grace-expired" &&
          deadline.payload.actorId === actorId,
        !expiryBacked,
      ),
    );
  }

  if (state.lifecycle.abandoned) return changes;
  const latestRoomExpiry =
    input.observations.length === 0
      ? undefined
      : Math.max(...input.observations.map(({ expiresAt }) => expiresAt));
  const expiryBacked = latestRoomExpiry !== undefined;
  appendDerivedChanges(
    prepareDerivedDeadline(
      state.deadlines,
      {
        deadlineId: `${expiryBacked ? "abandonment-expiry" : "abandonment"}:${String(state.lifecycle.roomActivityGeneration)}`,
        dueAt: (latestRoomExpiry ?? input.now) + ABANDONMENT_DEADLINE_MS,
        kind: "abandonment",
        payload: {
          type: "system/table-abandonment-expired",
          roomActivityGeneration: state.lifecycle.roomActivityGeneration,
        },
        status: "pending",
        targetGeneration: state.lifecycle.roomActivityGeneration,
      },
      (deadline) =>
        deadline.payload.type === "system/table-abandonment-expired" &&
        deadline.payload.roomActivityGeneration ===
          state.lifecycle.roomActivityGeneration,
      !expiryBacked,
    ),
  );
  return changes;
}
