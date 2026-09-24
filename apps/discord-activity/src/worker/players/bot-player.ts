import type {
  GameViewV2,
  HongKongGameCommandV2,
} from "@mahjong/rules-hong-kong";
import {
  CommandPlayer,
  type PlayerCommandSink,
  type PlayerInput,
  type PlayerView,
} from "./player.js";

export interface BotDecision {
  readonly choose: (
    view: GameViewV2,
  ) =>
    | HongKongGameCommandV2
    | undefined
    | Promise<HongKongGameCommandV2 | undefined>;
}

/** A policy receives only the same permitted game view as its human delegate. */
export class BotPlayer extends CommandPlayer {
  private readonly decision: BotDecision;
  private view: PlayerView | undefined;
  private pending: object | undefined;

  public constructor(actorId: string, decision: BotDecision) {
    super(actorId);
    this.decision = decision;
  }

  public receive(input: PlayerInput): void {
    if (this.isDisposed()) return;
    if (input.type === "view") this.view = input;
  }

  public override onCommand(sink: PlayerCommandSink): () => void {
    const revoke = super.onCommand(sink);
    let revoked = false;
    return () => {
      if (revoked) return;
      revoked = true;
      revoke();
      this.pending = undefined;
    };
  }

  public async run(input: {
    readonly commandId: string;
    readonly expectedStateVersion: number;
  }): Promise<boolean> {
    const view = this.view;
    if (
      !this.hasCommandConsumer ||
      this.pending !== undefined ||
      view?.game === undefined ||
      view.stateVersion !== input.expectedStateVersion
    )
      return false;
    const submit = this.commandSubmission();
    const pending = {};
    this.pending = pending;
    try {
      const command = await this.decision.choose(view.game);
      if (command === undefined || this.view !== view) return false;
      return await submit({ ...input, command });
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  public override dispose(): void {
    this.view = undefined;
    this.pending = undefined;
    super.dispose();
  }
}
