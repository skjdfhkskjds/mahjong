import type { BotPlayer } from "./bot-player.js";
import { CommandPlayer, type PlayerInput, type PlayerView } from "./player.js";
import type { UserPlayer } from "./user-player.js";

export type PlayerController = "HUMAN" | "BOT";

export interface ControllerAuthority {
  readonly kind: PlayerController;
  readonly generation: number;
}

/** Owns routing authority; the room persists each generation before activation. */
export class PlayerCoordinator extends CommandPlayer {
  private readonly user: UserPlayer;
  private readonly bot: BotPlayer;
  private authority: ControllerAuthority | undefined;
  private requestedAuthority: ControllerAuthority | undefined;
  private revoke: (() => void) | undefined;

  public constructor(actorId: string, user: UserPlayer, bot: BotPlayer) {
    super(actorId);
    if (user.actorId !== actorId || bot.actorId !== actorId)
      throw new Error("Controller identity does not match player.");
    this.user = user;
    this.bot = bot;
  }

  public get current(): ControllerAuthority | undefined {
    return this.authority;
  }

  public isCurrent(kind: PlayerController, generation: number): boolean {
    return (
      !this.isDisposed() &&
      this.authority?.kind === kind &&
      this.authority.generation === generation
    );
  }

  public checkHealth(): PlayerController {
    return this.user.healthy() ? "HUMAN" : "BOT";
  }

  public activate(
    kind: PlayerController,
    generation: number,
    view: PlayerView,
  ): void {
    if (this.isDisposed()) throw new Error("Player is disposed.");
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new Error("Invalid controller generation.");
    if (this.isCurrent(kind, generation)) {
      this.receive(view);
      return;
    }
    if (
      this.requestedAuthority !== undefined &&
      (generation < this.requestedAuthority.generation ||
        (generation === this.requestedAuthority.generation &&
          kind !== this.requestedAuthority.kind))
    )
      throw new Error("Controller generation must advance.");
    const continuingHuman =
      this.authority?.kind === "HUMAN" && kind === "HUMAN";
    this.revoke?.();
    this.revoke = undefined;
    this.authority = undefined;
    const requestedAuthority = { kind, generation };
    this.requestedAuthority = requestedAuthority;
    const controller = kind === "HUMAN" ? this.user : this.bot;
    // Deliver initialization while the controller has no authority to submit.
    // A human generation refresh (for example claiming a seat) does not emit
    // an unsolicited snapshot ahead of the command receipt. New/reconnecting
    // connections pass through UserPlayer.initialize explicitly.
    if (!continuingHuman) controller.receive(view);
    if (this.isDisposed() || this.requestedAuthority !== requestedAuthority)
      return;
    this.revoke = controller.onCommand(async (command) => {
      if (this.isCurrent(kind, generation))
        await this.commandSubmission()(command);
    });
    // Failed initialization leaves no active route. The persisted generation can
    // be retried, but no earlier or conflicting generation can regain control.
    this.authority = requestedAuthority;
  }

  public receive(input: PlayerInput): void {
    if (this.isDisposed() || this.authority === undefined) return;
    if (input.type === "outcome" && input.connectionIds !== undefined) {
      this.user.receive(input);
      return;
    }
    (this.authority.kind === "HUMAN" ? this.user : this.bot).receive(input);
  }

  public override dispose(): void {
    this.revoke?.();
    this.revoke = undefined;
    this.authority = undefined;
    this.requestedAuthority = undefined;
    this.user.dispose();
    this.bot.dispose();
    super.dispose();
  }
}
