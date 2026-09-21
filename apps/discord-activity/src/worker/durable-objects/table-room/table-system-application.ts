import type { BotWorkChanges } from "./table-bot-work.js";
import {
  controlsAfterPresence,
  prepareControllerWork,
  preparePlayerSubstitution,
  type ControllerSnapshot,
} from "./table-controller-application.js";
import {
  expireTableGame,
  tableGameDeadlineMatches,
  tableGameActorAt,
} from "./table-room-game-engine.js";
import {
  planDeadlineCompletion,
  prepareDeadlineCompletion,
  type DeadlineCompletionState,
  type PreparedDeadlineCompletion,
} from "./table-deadline-application.js";
import {
  prepareGameEventBatch,
  type PreparedGameEventBatch,
  type VerifiedStoredGame,
} from "./table-game-events.js";
import {
  prepareGameDeadlines,
  type GameDeadlineChanges,
} from "./table-game-scheduling.js";
import type {
  PresenceChanges,
  PresenceObservation,
  PresenceState,
} from "./table-presence-application.js";

export interface PreparedSystemOperation {
  readonly botWork?: BotWorkChanges;
  readonly completion: PreparedDeadlineCompletion;
  readonly game: PreparedGameEventBatch | undefined;
  readonly gameDeadlines: GameDeadlineChanges | undefined;
  readonly presence?: PresenceChanges;
  readonly abandonRoom: boolean;
  readonly publicTransition: boolean;
  readonly now: number;
}
export interface TableSystemStore {
  deadlineCompletion(deadlineId: string): DeadlineCompletionState;
  presenceState(): PresenceState;
  controllerSnapshot(): ControllerSnapshot;
  verifiedGame(): Promise<VerifiedStoredGame | undefined>;
  commitSystem(change: PreparedSystemOperation): void;
}

/** Queued work freshness is application policy; commits receive the chosen outcome. */
export async function processTableDeadline(
  store: TableSystemStore,
  deadlineId: string,
  now: number,
  observations: readonly PresenceObservation[],
  options: {
    readonly desiredBotActorIds: ReadonlySet<string>;
    readonly createCommandId: () => string;
  },
): Promise<boolean> {
  const plan = planDeadlineCompletion(
    { readDeadlineCompletion: (id) => store.deadlineCompletion(id) },
    deadlineId,
    now,
  );
  if (plan.type === "replayed") return false;
  if (plan.type === "complete") {
    store.commitSystem({
      completion: plan.completion,
      game: undefined,
      gameDeadlines: undefined,
      abandonRoom: false,
      publicTransition: false,
      now,
    });
    return false;
  }
  const deadline = plan.deadline;
  const stored = await store.verifiedGame();
  const state = stored?.state.schemaVersion === 2 ? stored.state : undefined;
  const presence = store.presenceState();
  const controller = store.controllerSnapshot();
  const connected = new Set(
    observations
      .filter(({ expiresAt }) => expiresAt > now)
      .map(({ actorId }) => actorId),
  );
  const payload = deadline.payload;
  let current: boolean;
  switch (payload.type) {
    case "system/reaction-expired":
      current = state !== undefined && tableGameDeadlineMatches(state, payload);
      break;
    case "system/turn-expired":
      current =
        state !== undefined &&
        tableGameDeadlineMatches(state, payload) &&
        controller.controls.find(
          ({ actorId }) => actorId === tableGameActorAt(state, payload.seat),
        )?.controller !== "BOT";
      break;
    case "system/disconnect-grace-expired": {
      const automation = presence.automation.find(
        ({ actorId }) => actorId === payload.actorId,
      );
      current =
        automation?.connectionGeneration === payload.connectionGeneration &&
        !automation.autopilot &&
        options.desiredBotActorIds.has(payload.actorId) &&
        !connected.has(payload.actorId);
      break;
    }
    case "system/table-abandonment-expired":
      current =
        presence.lifecycle.roomActivityGeneration ===
          payload.roomActivityGeneration &&
        !presence.lifecycle.abandoned &&
        connected.size === 0;
  }
  let game: PreparedGameEventBatch | undefined;
  let gamePublic = false;
  if (
    current &&
    state !== undefined &&
    stored !== undefined &&
    (payload.type === "system/reaction-expired" ||
      payload.type === "system/turn-expired")
  ) {
    const decision = expireTableGame(state, deadline, now);
    if (decision.kind !== "rejected") {
      game = await prepareGameEventBatch(stored, decision.events);
      gamePublic = decision.visibility === "public";
    }
  }
  const substitution =
    current && payload.type === "system/disconnect-grace-expired"
      ? preparePlayerSubstitution({
          control: controller.controls.find(
            ({ actorId }) => actorId === payload.actorId,
          ),
          game: state,
          deadlines: presence.deadlines,
          now,
        })
      : undefined;
  const controls = controlsAfterPresence(
    controller.controls,
    substitution?.presence,
  );
  const abandonRoom =
    current && payload.type === "system/table-abandonment-expired";
  const publicTransition =
    gamePublic || substitution !== undefined || abandonRoom;
  const gameDeadlines =
    game !== undefined && gamePublic
      ? prepareGameDeadlines({
          state: game.finalState,
          now,
          deadlines: presence.deadlines,
          controls,
          connectedActorIds: connected,
          processingDeadlineId: deadline.deadlineId,
        })
      : substitution?.gameDeadlines;
  const botWork = current
    ? prepareControllerWork({
        controls,
        jobs: controller.jobs,
        game: game?.finalState.schemaVersion === 2 ? game.finalState : state,
        now,
        abandoned: presence.lifecycle.abandoned || abandonRoom,
        createCommandId: options.createCommandId,
      })
    : undefined;
  store.commitSystem({
    completion: prepareDeadlineCompletion(
      deadline,
      now,
      current
        ? { outcome: "processed", publicTransition }
        : { outcome: "no-op", reason: "stale-target" },
    ),
    game,
    gameDeadlines,
    ...(substitution === undefined ? {} : { presence: substitution.presence }),
    ...(botWork === undefined ? {} : { botWork }),
    abandonRoom,
    publicTransition,
    now,
  });
  return publicTransition;
}
