import type { ActivityInstance } from "./durable-objects/activity-instance.js";
import type { TableRoom } from "./durable-objects/table-room.js";

export type AuthenticationMode = "discord" | "mock";

export interface Env {
  readonly ACTIVITY_INSTANCE: DurableObjectNamespace<ActivityInstance>;
  readonly APP_MODE: AuthenticationMode;
  readonly ASSETS: Fetcher;
  readonly DISCORD_BOT_TOKEN?: string;
  readonly DISCORD_CLIENT_ID?: string;
  readonly DISCORD_CLIENT_SECRET?: string;
  readonly SESSION_COOKIE_NAME: string;
  readonly SESSION_SIGNING_KEY: string;
  readonly SESSION_SIGNING_KEY_PREVIOUS?: string;
  readonly SESSION_TTL_SECONDS: string;
  readonly TABLE_ROOM: DurableObjectNamespace<TableRoom>;
}
