import type { TableCommandEnvelope } from "../durable-objects/table-room/table-room-protocol.js";
import type { PlayerControl } from "../durable-objects/table-room/table-player-control.js";
import { BotPlayer, type BotDecision } from "./bot-player.js";
import {
  PlayerCoordinator,
  type ControllerAuthority,
} from "./player-coordinator.js";
import type { PlayerView } from "./player.js";
import { UserPlayer, type UserCommunication } from "./user-player.js";

export interface PlayerCommandResult {
  readonly applied: boolean;
  readonly broadcast: boolean;
  readonly response: string;
  readonly senderSnapshot: boolean;
  readonly stale: boolean;
}

interface CoordinatedPlayer {
  readonly user: UserPlayer;
  readonly bot: BotPlayer;
  readonly coordinator: PlayerCoordinator;
  result: PlayerCommandResult | undefined;
  connectionId: string | undefined;
}

function commandResult(
  player: CoordinatedPlayer,
): PlayerCommandResult | undefined {
  return player.result;
}

/** Runtime routing is reconstructed from persisted authority, never vice versa. */
export class TablePlayers {
  private readonly players = new Map<string, CoordinatedPlayer>();
  private readonly adapters: {
    readonly control: (actorId: string) => PlayerControl;
    readonly view: (actorId: string) => PlayerView;
    readonly communication: (actorId: string) => UserCommunication;
    readonly choose: BotDecision["choose"];
    readonly apply: (
      actorId: string,
      command: TableCommandEnvelope,
      authority: ControllerAuthority,
      connectionId?: string,
    ) => Promise<PlayerCommandResult>;
  };

  public constructor(adapters: TablePlayers["adapters"]) {
    this.adapters = adapters;
  }

  private sync(actorId: string, refreshBotView = true): CoordinatedPlayer {
    let player = this.players.get(actorId);
    if (player === undefined) {
      const user = new UserPlayer(
        actorId,
        this.adapters.communication(actorId),
      );
      const bot = new BotPlayer(actorId, { choose: this.adapters.choose });
      const coordinator = new PlayerCoordinator(actorId, user, bot);
      player = {
        user,
        bot,
        coordinator,
        result: undefined,
        connectionId: undefined,
      };
      const current = player;
      coordinator.onCommand(async (command) => {
        const authority = coordinator.current;
        if (authority === undefined) return;
        current.result = await this.adapters.apply(
          actorId,
          command,
          authority,
          current.connectionId,
        );
      });
      this.players.set(actorId, player);
    }
    const control = this.adapters.control(actorId);
    if (control.generation < (player.coordinator.current?.generation ?? 0)) {
      player.coordinator.dispose();
      this.players.delete(actorId);
      return this.sync(actorId);
    }
    if (!player.coordinator.isCurrent(control.controller, control.generation)) {
      player.coordinator.activate(control.controller, control.generation, {
        ...this.adapters.view(actorId),
        connectionIds: [],
      });
    } else if (control.controller === "BOT" && refreshBotView) {
      player.coordinator.receive(this.adapters.view(actorId));
    }
    return player;
  }

  /** First connection and eviction recovery use the identical snapshot gate. */
  public initialize(
    actorId: string,
    connectionId: string,
    view: PlayerView,
  ): void {
    const player = this.sync(actorId);
    if (player.coordinator.current?.kind === "HUMAN")
      player.user.initialize(connectionId, view);
  }

  /** Publish once per usable connection, restoring eviction-lost initialization. */
  public publish(actorId: string, excludedConnectionId?: string): void {
    const player = this.sync(actorId);
    const view = this.adapters.view(actorId);
    const connections = player.user
      .usableConnectionIds()
      .filter((id) => id !== excludedConnectionId);
    const initialized = connections.filter((id) =>
      player.user.isInitialized(id),
    );
    player.coordinator.receive({ ...view, connectionIds: initialized });
    if (player.coordinator.current?.kind === "HUMAN") {
      for (const connectionId of connections) {
        if (!initialized.includes(connectionId))
          player.user.initialize(connectionId, view);
      }
    }
  }

  public snapshot(actorId: string, connectionId: string): void {
    const player = this.sync(actorId);
    const view = this.adapters.view(actorId);
    if (player.coordinator.current?.kind !== "HUMAN") return;
    if (player.user.isInitialized(connectionId)) {
      player.coordinator.receive({ ...view, connectionIds: [connectionId] });
    } else {
      player.user.initialize(connectionId, view);
    }
  }

  /** Call before changed(): the committed origin remains the receipt recipient. */
  public outcome(actorId: string, connectionId: string, message: string): void {
    this.players.get(actorId)?.coordinator.receive({
      type: "outcome",
      message,
      connectionIds: [connectionId],
    });
  }

  /** Observes health without bypassing persisted grace and authority. */
  public health(actorId: string): {
    readonly available: boolean;
    readonly desiredController: "HUMAN" | "BOT";
    readonly authority: ControllerAuthority | undefined;
  } {
    const player = this.sync(actorId, false);
    return {
      available: player.user.healthy(),
      desiredController: player.coordinator.checkHealth(),
      authority: player.coordinator.current,
    };
  }

  public async human(
    actorId: string,
    connectionId: string,
    command: TableCommandEnvelope,
  ): Promise<PlayerCommandResult | undefined> {
    const player = this.sync(actorId);
    player.result = undefined;
    // Hibernation loses routing objects, not accepted sockets. Reinitialize
    // those objects with a current projection before accepting their input.
    if (
      player.coordinator.current?.kind === "HUMAN" &&
      !player.user.isInitialized(connectionId)
    )
      player.user.initialize(connectionId, this.adapters.view(actorId));
    player.connectionId = connectionId;
    try {
      await player.user.submit(connectionId, command);
    } finally {
      player.connectionId = undefined;
    }
    return player.result;
  }

  public async bot(
    actorId: string,
    generation: number,
    commandId: string,
    expectedStateVersion: number,
  ): Promise<PlayerCommandResult | undefined> {
    const player = this.sync(actorId);
    player.result = undefined;
    if (!player.coordinator.isCurrent("BOT", generation)) return undefined;
    await player.bot.run({ commandId, expectedStateVersion });
    const result = commandResult(player);
    if (result !== undefined && player.coordinator.isCurrent("BOT", generation))
      player.coordinator.receive({
        type: "outcome",
        message: result.response,
      });
    return result;
  }

  public changed(actorId: string): void {
    const player = this.sync(actorId);
    if (player.coordinator.current?.kind === "BOT") player.user.depart();
  }
}
