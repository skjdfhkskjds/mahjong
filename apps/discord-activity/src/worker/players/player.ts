import type { GameViewV2 } from "@mahjong/rules-hong-kong";
import type { TableCommandEnvelope } from "../durable-objects/table-room/table-room-protocol.js";

export interface PlayerView {
  readonly type: "view";
  readonly stateVersion: number;
  readonly game?: GameViewV2;
  /** Already projected and encoded for this player by the authoritative room. */
  readonly snapshot: string;
  /** A runtime-selected audience within this actor's connections. */
  readonly connectionIds?: readonly string[];
}

export type PlayerInput =
  | PlayerView
  | {
      readonly type: "outcome";
      readonly message: string;
      readonly connectionIds?: readonly string[];
    };

export type PlayerCommandSink = (
  command: TableCommandEnvelope,
) => Promise<void>;

/** The same application communication boundary for humans, bots, and routing. */
export interface Player {
  readonly actorId: string;
  receive(input: PlayerInput): void;
  onCommand(sink: PlayerCommandSink): () => void;
  dispose(): void;
}

/** Single-consumer command routing with revocable callbacks for async work. */
export abstract class CommandPlayer implements Player {
  public readonly actorId: string;
  private sink: PlayerCommandSink | undefined;
  private subscription = 0;
  private disposed = false;

  protected constructor(actorId: string) {
    this.actorId = actorId;
  }

  public abstract receive(input: PlayerInput): void;

  public onCommand(sink: PlayerCommandSink): () => void {
    if (this.disposed) throw new Error("Player is disposed.");
    if (this.sink !== undefined)
      throw new Error("Player already has a command consumer.");
    this.subscription += 1;
    const subscription = this.subscription;
    this.sink = sink;
    return () => {
      if (this.subscription === subscription) {
        this.subscription += 1;
        this.sink = undefined;
      }
    };
  }

  protected commandSubmission(): (
    command: TableCommandEnvelope,
  ) => Promise<boolean> {
    const subscription = this.subscription;
    const sink = this.sink;
    return async (command) => {
      if (
        this.disposed ||
        sink === undefined ||
        this.subscription !== subscription
      )
        return false;
      await sink(command);
      return true;
    };
  }

  protected isDisposed(): boolean {
    return this.disposed;
  }

  protected get hasCommandConsumer(): boolean {
    return this.sink !== undefined && !this.disposed;
  }

  public dispose(): void {
    this.disposed = true;
    this.subscription += 1;
    this.sink = undefined;
  }
}
