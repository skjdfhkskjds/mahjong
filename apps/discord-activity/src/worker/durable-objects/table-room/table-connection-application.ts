import {
  controlsAfterPresence,
  prepareControllerWork,
  type ControllerSnapshot,
} from "./table-controller-application.js";
import type { BotWorkChanges } from "./table-bot-work.js";
import type { CanonicalGameStateV1 } from "@mahjong/rules-hong-kong";
import {
  accessBindingAuthorized,
  type AccessBindingAuthorization,
  type TableAccessStore,
} from "./table-access-application.js";
import {
  preparePresenceReconciliation,
  prepareValidConnection,
  type PresenceChanges,
  type PresenceObservation,
  type PresenceState,
} from "./table-presence-application.js";
import {
  prepareGameDeadlines,
  type GameDeadlineChanges,
} from "./table-game-scheduling.js";
import { tableGameDeadline } from "./table-room-game-engine.js";

export interface ConnectionGrant extends AccessBindingAuthorization {
  readonly actorId: string;
  readonly displayName: string;
  readonly expiresAt: number;
  readonly sessionGeneration: number;
  readonly tableId: string;
}
export type ConnectionCommit =
  | {
      readonly kind: "connect";
      readonly botWork?: BotWorkChanges;
      readonly connectionGeneration: string;
      readonly grant: ConnectionGrant;
      readonly presence: PresenceChanges;
      readonly publicTransition: boolean;
    }
  | {
      readonly kind: "reconcile";
      readonly botWork?: BotWorkChanges;
      readonly presence: PresenceChanges;
      readonly gameDeadlines: GameDeadlineChanges | undefined;
    }
  | {
      readonly kind: "disconnect";
      readonly botWork?: BotWorkChanges;
      readonly connectionGeneration: string;
      readonly presence: PresenceChanges;
    };
export interface TableConnectionStore {
  presenceState(): PresenceState;
  controllerSnapshot(): ControllerSnapshot;
  commitConnection(change: ConnectionCommit): void;
}
export function connectionAuthorityIsCurrent(
  store: Pick<TableAccessStore, "table" | "memberRole" | "sessionGeneration">,
  grant: ConnectionGrant,
): boolean {
  const table = store.table();
  return (
    !grant.actorId.startsWith("bot:") &&
    table?.tableId === grant.tableId &&
    accessBindingAuthorized(grant, table) &&
    store.memberRole(grant.actorId) !== undefined &&
    store.sessionGeneration(grant.actorId) === grant.sessionGeneration
  );
}
export function activateTableConnection(
  store: TableConnectionStore,
  grant: ConnectionGrant,
  connectionGeneration: string,
  input: {
    readonly now: number;
    readonly game: CanonicalGameStateV1 | undefined;
    readonly createCommandId: () => string;
  },
): boolean {
  const state = store.presenceState();
  const snapshot = store.controllerSnapshot();
  const transition = prepareValidConnection(state, grant.actorId, input.now);
  const botWork = prepareControllerWork({
    controls: controlsAfterPresence(snapshot.controls, transition.changes),
    jobs: snapshot.jobs,
    game: input.game,
    now: input.now,
    abandoned:
      transition.changes.lifecycle?.abandoned ?? state.lifecycle.abandoned,
    createCommandId: input.createCommandId,
  });
  store.commitConnection({
    kind: "connect",
    grant,
    connectionGeneration,
    presence: transition.changes,
    botWork,
    publicTransition: transition.publicTransition,
  });
  return transition.publicTransition;
}
export function reconcileTableWork(
  store: TableConnectionStore,
  input: {
    readonly now: number;
    readonly observations: readonly PresenceObservation[];
    readonly game: CanonicalGameStateV1 | undefined;
    readonly connectedActorId?: string;
    readonly refreshGameDeadlines?: boolean;
    readonly createCommandId: () => string;
  },
): void {
  const state = store.presenceState();
  const presence = preparePresenceReconciliation(state, input);
  const snapshot = store.controllerSnapshot();
  const controls = controlsAfterPresence(snapshot.controls, presence);
  const botWork = prepareControllerWork({
    controls,
    jobs: snapshot.jobs,
    game: input.game,
    now: input.now,
    abandoned: presence.lifecycle?.abandoned ?? state.lifecycle.abandoned,
    createCommandId: input.createCommandId,
  });
  const target =
    input.game === undefined ? null : tableGameDeadline(input.game);
  const refreshGame =
    input.refreshGameDeadlines !== false &&
    input.game !== undefined &&
    (input.connectedActorId === undefined ||
      (target?.kind === "turn" && target.actorId === input.connectedActorId));
  const gameDeadlines = refreshGame
    ? prepareGameDeadlines({
        state: input.game,
        now: input.now,
        deadlines: state.deadlines,
        controls,
        connectedActorIds: new Set(
          input.observations
            .filter(({ expiresAt }) => expiresAt > input.now)
            .map(({ actorId }) => actorId),
        ),
      })
    : undefined;
  store.commitConnection({
    kind: "reconcile",
    presence,
    gameDeadlines,
    botWork,
  });
}
export function closeTableConnection(
  store: TableConnectionStore,
  connectionGeneration: string,
  input: {
    readonly now: number;
    readonly observations: readonly PresenceObservation[];
    readonly game: CanonicalGameStateV1 | undefined;
    readonly createCommandId: () => string;
  },
): void {
  const state = store.presenceState();
  const presence = preparePresenceReconciliation(state, input);
  const snapshot = store.controllerSnapshot();
  const botWork = prepareControllerWork({
    controls: controlsAfterPresence(snapshot.controls, presence),
    jobs: snapshot.jobs,
    game: input.game,
    now: input.now,
    abandoned: presence.lifecycle?.abandoned ?? state.lifecycle.abandoned,
    createCommandId: input.createCommandId,
  });
  store.commitConnection({
    kind: "disconnect",
    connectionGeneration,
    presence,
    botWork,
  });
}
