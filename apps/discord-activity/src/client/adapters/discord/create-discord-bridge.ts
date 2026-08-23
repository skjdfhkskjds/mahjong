import type { RuntimeConfig } from "../../bootstrap/runtime-config.js";
import type { DiscordBridge } from "./discord-bridge.js";
import { EmbeddedDiscordBridge } from "./embedded-discord-bridge.js";
import { MockDiscordBridge } from "./mock-discord-bridge.js";

export function createDiscordBridge(config: RuntimeConfig): DiscordBridge {
  if (config.mode === "mock") {
    return new MockDiscordBridge(config.mockActor);
  }

  if (!config.discordClientId) {
    throw new Error(
      "Discord client ID is missing after configuration validation.",
    );
  }

  return new EmbeddedDiscordBridge(config.discordClientId);
}
