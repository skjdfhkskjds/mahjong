import type { ActivityRuntimeMode } from "../../bootstrap/runtime-config.js";

export interface ActivityContext {
  readonly instanceId: string;
}

export interface ActivityActor {
  readonly id: string;
  readonly displayName: string;
}

export interface DiscordAuthorization {
  readonly code: string;
}

export interface DiscordBridge {
  readonly mode: ActivityRuntimeMode;

  initialize(): Promise<ActivityContext>;

  authorize(): Promise<DiscordAuthorization | undefined>;

  authenticate(accessToken: string): Promise<ActivityActor>;
}
