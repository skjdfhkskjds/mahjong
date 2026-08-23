import { DiscordSDK } from "@discord/embedded-app-sdk";

import type {
  ActivityActor,
  ActivityContext,
  DiscordAuthorization,
  DiscordBridge,
} from "./discord-bridge.js";

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

export class EmbeddedDiscordBridge implements DiscordBridge {
  public readonly mode = "discord" as const;

  private readonly clientId: string;
  private readonly sdk: DiscordSDK;

  public constructor(clientId: string) {
    this.clientId = clientId;
    this.sdk = new DiscordSDK(clientId);
  }

  public async initialize(): Promise<ActivityContext> {
    await this.sdk.ready();

    if (!this.sdk.instanceId) {
      throw new Error("Discord did not provide an Activity instance ID.");
    }

    return { instanceId: this.sdk.instanceId };
  }

  public async authorize(): Promise<DiscordAuthorization> {
    const authorization = await this.sdk.commands.authorize({
      client_id: this.clientId,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify"],
    });

    if (!authorization.code) {
      throw new Error("Discord authorization did not return a code.");
    }

    return { code: authorization.code };
  }

  public async authenticate(accessToken: string): Promise<ActivityActor> {
    const authentication: unknown = await this.sdk.commands.authenticate({
      access_token: accessToken,
    });
    if (
      typeof authentication !== "object" ||
      authentication === null ||
      !("user" in authentication) ||
      typeof authentication.user !== "object" ||
      authentication.user === null
    ) {
      throw new Error("Discord SDK authentication did not return a user.");
    }
    const user = authentication.user as Record<string, unknown>;
    const id = user["id"];
    const username = user["username"];
    const globalName = user["global_name"];
    if (
      !isBoundedString(id, 96) ||
      !isBoundedString(username, 40) ||
      (globalName !== undefined &&
        globalName !== null &&
        !isBoundedString(globalName, 40))
    ) {
      throw new Error("Discord SDK authentication returned an invalid user.");
    }

    return {
      id,
      displayName: globalName ?? username,
    };
  }
}
