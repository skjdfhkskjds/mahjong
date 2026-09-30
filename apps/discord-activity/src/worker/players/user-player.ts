import type { TableCommandEnvelope } from "../durable-objects/table-room/table-room-protocol.js";
import { CommandPlayer, type PlayerInput, type PlayerView } from "./player.js";

export interface UserConnection {
  /** An authorization generation, not merely a reusable socket address. */
  readonly id: string;
  readonly usable: boolean;
}

export interface UserCommunication {
  readonly connections: () => readonly UserConnection[];
  readonly send: (connectionId: string, input: PlayerInput) => void;
}

/** Adapts authorized connections without exposing their transport to routing. */
export class UserPlayer extends CommandPlayer {
  private readonly communication: UserCommunication;
  private readonly initialized = new Set<string>();
  private readonly failed = new Set<string>();
  private departed = false;

  public constructor(actorId: string, communication: UserCommunication) {
    super(actorId);
    this.communication = communication;
  }

  public available(): boolean {
    return (
      !this.isDisposed() &&
      !this.departed &&
      this.communication
        .connections()
        .some(({ id, usable }) => usable && this.initialized.has(id))
    );
  }

  public isInitialized(connectionId: string): boolean {
    return this.initialized.has(connectionId) && this.usable(connectionId);
  }

  /** Transport evidence also exists before an evicted route initializes. */
  public healthy(): boolean {
    return (
      !this.isDisposed() &&
      !this.departed &&
      this.usableConnectionIds().length > 0
    );
  }

  public usableConnectionIds(): readonly string[] {
    return this.isDisposed()
      ? []
      : this.communication
          .connections()
          .filter(({ id, usable }) => usable && !this.failed.has(id))
          .map(({ id }) => id);
  }

  public initialize(connectionId: string, view: PlayerView): boolean {
    this.initialized.delete(connectionId);
    if (this.isDisposed() || !this.authorized(connectionId)) return false;
    if (!this.deliver(connectionId, view)) return false;
    this.failed.delete(connectionId);
    // A synchronous transport callback may invalidate its authorization.
    if (this.isDisposed() || !this.usable(connectionId)) return false;
    this.initialized.add(connectionId);
    this.departed = false;
    return true;
  }

  public depart(): void {
    this.departed = true;
    this.initialized.clear();
  }

  public receive(input: PlayerInput): void {
    if (this.isDisposed()) return;
    if (input.type === "outcome" && input.connectionIds !== undefined) {
      // A committed command's origin may just have revoked its own grant. Its
      // private receipt is still permitted, without re-enabling human commands.
      const known = new Set(
        this.communication.connections().map(({ id }) => id),
      );
      for (const connectionId of input.connectionIds) {
        if (known.has(connectionId)) this.deliver(connectionId, input);
      }
      return;
    }
    for (const connectionId of this.initialized) {
      if (
        input.connectionIds !== undefined &&
        !input.connectionIds.includes(connectionId)
      )
        continue;
      if (!this.usable(connectionId)) this.initialized.delete(connectionId);
      else this.deliver(connectionId, input);
    }
  }

  public async submit(
    connectionId: string,
    command: TableCommandEnvelope,
  ): Promise<boolean> {
    if (
      !this.available() ||
      !this.initialized.has(connectionId) ||
      !this.usable(connectionId)
    )
      return false;
    return this.commandSubmission()(command);
  }

  private usable(connectionId: string): boolean {
    return !this.failed.has(connectionId) && this.authorized(connectionId);
  }

  private authorized(connectionId: string): boolean {
    return this.communication
      .connections()
      .some(({ id, usable }) => id === connectionId && usable);
  }

  private deliver(connectionId: string, input: PlayerInput): boolean {
    try {
      this.communication.send(connectionId, input);
      return true;
    } catch {
      // One failed transport must not interrupt other connections or leave this
      // connection eligible to submit without a successful fresh snapshot.
      this.initialized.delete(connectionId);
      this.failed.add(connectionId);
      return false;
    }
  }

  public override dispose(): void {
    this.initialized.clear();
    this.failed.clear();
    super.dispose();
  }
}
