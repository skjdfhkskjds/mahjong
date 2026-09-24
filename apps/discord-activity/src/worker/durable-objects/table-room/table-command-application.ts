import type { BotWorkChanges } from "./table-bot-work.js";
import type { BotSeatChange } from "./table-bot-seating.js";
import { prepareBotSeatChange } from "./table-bot-seating.js";
import type { ControllerAuthority } from "../../players/player-coordinator.js";
import {
  controlsAfterPresence,
  prepareControllerWork,
  preparePlayerSubstitution,
  type ControllerSnapshot,
} from "./table-controller-application.js";
import type { PlayerControl } from "./table-player-control.js";
import {
  HONG_KONG_V1_RANDOM_BYTES,
  type CanonicalGameStateV1,
  type HongKongGameCommandV1,
} from "@mahjong/rules-hong-kong";

import { startTableGame, tableGameEngine } from "./table-room-game-engine.js";
import {
  canonicalTableRequest,
  type TableCommandEnvelope,
  type TableSeat,
} from "./table-room-protocol.js";
import {
  prepareGameEventBatch,
  type PreparedGameEventBatch,
  type VerifiedStoredGame,
} from "./table-game-events.js";
import {
  prepareGameDeadlines,
  type GameDeadlineChanges,
} from "./table-game-scheduling.js";
import {
  preparePresenceReconciliation,
  type PresenceChanges,
  type PresenceObservation,
  type PresenceState,
} from "./table-presence-application.js";

export interface ApplicationSeat {
  readonly seat: TableSeat;
  readonly actorId: string;
  readonly displayName: string;
  readonly ready: boolean;
}
export interface CommandReceipt {
  readonly actorId: string;
  readonly requestJson: string;
  readonly response: string;
}
export interface CommandState {
  readonly ownerId: string | undefined;
  readonly controllers: ControllerSnapshot;
  readonly stateVersion: number;
  readonly gameExists: boolean;
  readonly seats: readonly ApplicationSeat[];
  readonly memberDisplayName: string;
  readonly presence: PresenceState;
}
export type SeatChange =
  | { readonly kind: "none" }
  | { readonly kind: "put"; readonly seat: ApplicationSeat }
  | { readonly kind: "remove"; readonly actorId: string };
export interface PreparedTableCommand {
  readonly removeConnectionGeneration?: string;
  readonly botWork?: BotWorkChanges;
  readonly botSeatChange?: BotSeatChange;
  readonly commandId: string;
  readonly receipt: CommandReceipt;
  readonly now: number;
  readonly stateVersion: number;
  readonly seatChange: SeatChange;
  readonly game: PreparedGameEventBatch | undefined;
  readonly gameDeadlines: GameDeadlineChanges | undefined;
  readonly presence: PresenceChanges | undefined;
}
export interface TableCommandStore {
  controllerSnapshot(): ControllerSnapshot;
  receipt(commandId: string): CommandReceipt | undefined;
  commandState(actorId: string): CommandState;
  verifiedGame(): Promise<VerifiedStoredGame | undefined>;
  commitCommand(
    change: PreparedTableCommand,
  ):
    | { readonly kind: "committed" }
    | { readonly kind: "duplicate"; readonly receipt: CommandReceipt };
}
export interface TableCommandResult {
  readonly applied: boolean;
  readonly broadcast: boolean;
  readonly response: string;
  readonly senderSnapshot: boolean;
  readonly stale: boolean;
}
interface Rejection {
  readonly code: string;
  readonly message: string;
}
function receipt(
  commandId: string,
  applied: boolean,
  stateVersion: number,
  error?: Rejection,
): string {
  return JSON.stringify({
    type: "table/receipt",
    protocolVersion: 1,
    commandId,
    outcome: applied ? "applied" : "rejected",
    stateVersion,
    ...(error === undefined ? {} : { error }),
  });
}
function replay(
  existing: CommandReceipt,
  actorId: string,
  requestJson: string,
  envelope: TableCommandEnvelope,
  version: number,
): TableCommandResult {
  if (existing.actorId !== actorId || existing.requestJson !== requestJson) {
    return {
      applied: false,
      broadcast: false,
      senderSnapshot: false,
      stale: false,
      response: receipt(envelope.commandId, false, version, {
        code: "command-id-collision",
        message: "The command identifier was already used.",
      }),
    };
  }
  const response = JSON.parse(existing.response) as {
    readonly error?: { readonly code?: string };
  };
  return {
    applied: false,
    broadcast: false,
    response: existing.response,
    senderSnapshot: envelope.command.type === "game/react",
    stale: response.error?.code === "stale-state-version",
  };
}
function isGameCommand(
  command: TableCommandEnvelope["command"],
): command is HongKongGameCommandV1 {
  return command.type.startsWith("game/") && command.type !== "game/start";
}

/** The caller holds serialization across verified reads, async hashing, and commit. */
export async function executeTableCommand(
  store: TableCommandStore,
  input: {
    readonly actorId: string;
    readonly envelope: TableCommandEnvelope;
    readonly now: number;
    readonly observations: readonly PresenceObservation[];
    readonly randomBytes: (length: number) => Uint8Array;
    readonly authority: ControllerAuthority;
    readonly createCommandId: () => string;
    readonly newBotActorId: () => string;
    readonly departingConnectionGeneration?: string;
  },
): Promise<TableCommandResult> {
  const { actorId, envelope, now } = input;
  const requestJson = canonicalTableRequest(envelope);
  const state = store.commandState(actorId);
  const currentAuthority = (snapshot: ControllerSnapshot): boolean => {
    const control = snapshot.controls.find(
      (entry) => entry.actorId === actorId,
    );
    return (
      (control?.controller ?? "HUMAN") === input.authority.kind &&
      (control?.generation ?? 0) === input.authority.generation
    );
  };
  const inactive = (): TableCommandResult => ({
    applied: false,
    broadcast: false,
    senderSnapshot: true,
    stale: false,
    response: receipt(envelope.commandId, false, state.stateVersion, {
      code: "inactive-controller",
      message: "This player's active controller changed; reconnect to resume.",
    }),
  });
  if (!currentAuthority(state.controllers)) return inactive();
  const existing = store.receipt(envelope.commandId);
  if (existing !== undefined)
    return replay(existing, actorId, requestJson, envelope, state.stateVersion);
  let rejection: Rejection | undefined;
  let stale = false;
  let publicTransition = false;
  let applied = false;
  let game: PreparedGameEventBatch | undefined;
  let seatChange: SeatChange = { kind: "none" };
  let botSeatChange: BotSeatChange | undefined;
  let presence: PresenceChanges | undefined;
  let gameDeadlines: GameDeadlineChanges | undefined;
  let currentGame: CanonicalGameStateV1 | undefined;
  let removeConnectionGeneration: string | undefined;
  const command = envelope.command;
  if (envelope.expectedStateVersion !== state.stateVersion) {
    stale = true;
    rejection = {
      code: "stale-state-version",
      message: "The table state changed; resynchronize and retry.",
    };
  } else if (command.type === "game/start") {
    if (state.gameExists)
      rejection = {
        code: "game-already-started",
        message: "This game has already started.",
      };
    else if (
      state.seats.length !== 4 ||
      state.seats.some(({ ready }) => !ready)
    )
      rejection = {
        code: "table-not-ready",
        message: "Four seated players must be ready before starting.",
      };
    else if (!state.seats.some((seat) => seat.actorId === actorId))
      rejection = {
        code: "spectator-cannot-start",
        message: "Only a seated player can start the game.",
      };
    else {
      const playerAt = (seat: TableSeat): string => {
        const actor = state.seats.find((row) => row.seat === seat)?.actorId;
        if (actor === undefined)
          throw new Error("A ready table has an incomplete seat map.");
        return actor;
      };
      const started = startTableGame(
        {
          east: playerAt("east"),
          south: playerAt("south"),
          west: playerAt("west"),
          north: playerAt("north"),
        },
        input.randomBytes(HONG_KONG_V1_RANDOM_BYTES),
      );
      game = await prepareGameEventBatch(undefined, [started.event]);
      applied = true;
      publicTransition = true;
    }
  } else if (isGameCommand(command)) {
    const stored = await store.verifiedGame();
    if (!currentAuthority(store.controllerSnapshot())) return inactive();
    if (stored === undefined)
      rejection = {
        code: "game-not-started",
        message: "The game has not started.",
      };
    else {
      currentGame = stored.state;
      const decision = tableGameEngine.execute(stored.state, actorId, command);
      if (decision.kind === "rejected") rejection = decision.error;
      else {
        game = await prepareGameEventBatch(stored, decision.events);
        applied = true;
        publicTransition = decision.visibility === "public";
      }
    }
  } else if (state.gameExists && command.type === "lobby/leave-seat") {
    const control = state.controllers.controls.find(
      (entry) => entry.actorId === actorId,
    );
    if (
      control?.kind !== "HUMAN" ||
      input.departingConnectionGeneration === undefined
    ) {
      rejection = {
        code: "not-seated",
        message: "Only a seated human can leave this hand.",
      };
    } else {
      const stored = await store.verifiedGame();
      currentGame = stored?.state;
      removeConnectionGeneration = input.departingConnectionGeneration;
      applied = true;
      if (
        !input.observations.some(
          (observation) =>
            observation.actorId === actorId && observation.expiresAt > now,
        )
      ) {
        const substitution = preparePlayerSubstitution({
          control,
          game: currentGame,
          deadlines: state.presence.deadlines,
          now,
        });
        if (substitution !== undefined) {
          presence = substitution.presence;
          gameDeadlines = substitution.gameDeadlines;
          publicTransition = true;
        }
      }
    }
  } else if (state.gameExists)
    rejection = {
      code: "lobby-closed",
      message: "Seats and readiness are locked after the game starts.",
    };
  else if (
    command.type === "lobby/add-bot" ||
    command.type === "lobby/remove-bot"
  ) {
    const decision = prepareBotSeatChange({
      actorId,
      ownerId: state.ownerId,
      seat: command.seat,
      command: command.type,
      seats: state.seats,
      botIds: new Set(
        state.controllers.controls
          .filter((control) => control.kind === "BOT")
          .map((control) => control.actorId),
      ),
      newActorId: input.newBotActorId,
    });
    if (decision.kind === "rejected") rejection = decision.error;
    else {
      botSeatChange = decision.change;
      applied = true;
      publicTransition = true;
    }
  } else {
    const current = state.seats.find((seat) => seat.actorId === actorId);
    if (command.type === "lobby/claim-seat") {
      const occupied = state.seats.find((seat) => seat.seat === command.seat);
      if (occupied !== undefined && occupied.actorId !== actorId)
        rejection = {
          code: "seat-unavailable",
          message: "That seat is already occupied.",
        };
      else if (current?.seat === command.seat)
        rejection = {
          code: "no-state-change",
          message: "The actor already occupies that seat.",
        };
      else
        seatChange = {
          kind: "put",
          seat: {
            seat: command.seat,
            actorId,
            displayName: state.memberDisplayName,
            ready: false,
          },
        };
    } else if (command.type === "lobby/leave-seat") {
      if (current === undefined)
        rejection = {
          code: "not-seated",
          message: "The actor does not occupy a seat.",
        };
      else seatChange = { kind: "remove", actorId };
    } else if (current === undefined)
      rejection = {
        code: "not-seated",
        message: "Only a seated player can change ready state.",
      };
    else if (current.ready === command.ready)
      rejection = {
        code: "no-state-change",
        message: "The requested ready state is already current.",
      };
    else
      seatChange = { kind: "put", seat: { ...current, ready: command.ready } };
    applied = seatChange.kind !== "none";
    publicTransition = applied;
  }
  let controls: readonly PlayerControl[] = controlsAfterPresence(
    state.controllers.controls,
    presence,
  );
  if (botSeatChange?.kind === "add")
    controls = [
      ...controls,
      {
        actorId: botSeatChange.seat.actorId,
        kind: "BOT",
        controller: "BOT",
        generation: 0,
      },
    ];
  else if (botSeatChange?.kind === "remove") {
    const removedActor = botSeatChange.actorId;
    controls = controls.filter(({ actorId }) => actorId !== removedActor);
  }
  if (
    applied &&
    (command.type === "lobby/claim-seat" || command.type === "lobby/leave-seat")
  ) {
    const seats = state.gameExists
      ? [...state.seats]
      : state.seats.filter((seat) => seat.actorId !== actorId);
    if (seatChange.kind === "put") seats.push(seatChange.seat);
    const automated = new Map(
      state.presence.automation.map((entry) => [entry.actorId, entry]),
    );
    for (const change of presence?.automation ?? []) {
      if (change.type === "delete") automated.delete(change.actorId);
      else automated.set(change.automation.actorId, change.automation);
    }
    const reconciled = preparePresenceReconciliation(
      {
        ...state.presence,
        automation: [...automated.values()],
        seatedActorIds: [...seats]
          .filter(
            (seat) =>
              !controls.some(
                (control) =>
                  control.actorId === seat.actorId && control.kind === "BOT",
              ),
          )
          .sort(
            (left, right) =>
              ["east", "south", "west", "north"].indexOf(left.seat) -
              ["east", "south", "west", "north"].indexOf(right.seat),
          )
          .map(({ actorId }) => actorId),
      },
      { now, observations: input.observations },
    );
    presence = {
      ...reconciled,
      automation: [...(presence?.automation ?? []), ...reconciled.automation],
    };
    controls = controlsAfterPresence(controls, presence);
  }
  if (game !== undefined && publicTransition)
    gameDeadlines = prepareGameDeadlines({
      state: game.finalState,
      now,
      deadlines: state.presence.deadlines,
      controls,
      connectedActorIds: new Set(
        input.observations
          .filter(({ expiresAt }) => expiresAt > now)
          .map(({ actorId }) => actorId),
      ),
    });
  const botWork = applied
    ? prepareControllerWork({
        controls,
        jobs: state.controllers.jobs,
        game: game?.finalState ?? currentGame,
        now,
        abandoned:
          presence?.lifecycle?.abandoned ?? state.presence.lifecycle.abandoned,
        createCommandId: input.createCommandId,
      })
    : undefined;
  if (!currentAuthority(store.controllerSnapshot())) return inactive();
  const stateVersion = state.stateVersion + Number(applied && publicTransition);
  const response = receipt(
    envelope.commandId,
    applied,
    stateVersion,
    rejection,
  );
  const committed = store.commitCommand({
    commandId: envelope.commandId,
    receipt: { actorId, requestJson, response },
    now,
    stateVersion,
    seatChange,
    game,
    gameDeadlines,
    presence,
    ...(botWork === undefined ? {} : { botWork }),
    ...(botSeatChange === undefined ? {} : { botSeatChange }),
    ...(removeConnectionGeneration === undefined
      ? {}
      : { removeConnectionGeneration }),
  });
  if (committed.kind === "duplicate")
    return replay(
      committed.receipt,
      actorId,
      requestJson,
      envelope,
      stateVersion,
    );
  return {
    applied,
    broadcast: applied && publicTransition,
    response,
    senderSnapshot: applied && !publicTransition,
    stale,
  };
}
