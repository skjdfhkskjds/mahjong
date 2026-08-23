import type {
  ActivityActor,
  ActivityContext,
  DiscordAuthorization,
  DiscordBridge,
} from "./discord-bridge.js";

export class MockDiscordBridge implements DiscordBridge {
  public readonly mode = "mock" as const;
  private readonly actor: ActivityActor;

  public constructor(actor: ActivityActor) {
    this.actor = actor;
  }

  public initialize(): Promise<ActivityContext> {
    return Promise.resolve({ instanceId: "standalone-local-instance" });
  }

  public authorize(): Promise<DiscordAuthorization | undefined> {
    return Promise.resolve(undefined);
  }

  public authenticate(): Promise<ActivityActor> {
    return Promise.resolve(this.actor);
  }

  public getActor(): ActivityActor {
    return this.actor;
  }
}
