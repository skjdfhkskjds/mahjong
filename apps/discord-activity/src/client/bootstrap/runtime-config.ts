export type ActivityRuntimeMode = "discord" | "mock";

export interface RuntimeConfig {
  readonly mode: ActivityRuntimeMode;
  readonly discordClientId?: string;
  readonly apiBaseUrl: string;
  readonly mockActor: {
    readonly id: string;
    readonly displayName: string;
  };
}

export interface RuntimeEnvironment {
  readonly VITE_ACTIVITY_MODE?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DISCORD_CLIENT_ID?: string;
  readonly VITE_MOCK_ACTOR_ID?: string;
  readonly VITE_MOCK_DISPLAY_NAME?: string;
}

export class RuntimeConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

function selectMode(value: string | null | undefined): ActivityRuntimeMode {
  if (value === undefined || value === null || value === "") {
    return "mock";
  }

  if (value === "mock" || value === "discord") {
    return value;
  }

  throw new RuntimeConfigurationError(
    `Unknown Activity runtime mode: ${value}. Expected "mock" or "discord".`,
  );
}

function normalizeApiBaseUrl(value: string | undefined): string {
  if (value === undefined || value === "" || value === "/") {
    return "";
  }

  return value.replace(/\/+$/, "");
}

function nonEmptyOr(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? fallback : normalized;
}

export function readRuntimeConfig(
  search: string,
  environment: RuntimeEnvironment,
): RuntimeConfig {
  const query = new URLSearchParams(search);
  const mode = selectMode(
    query.get("activity_mode") ?? environment.VITE_ACTIVITY_MODE,
  );
  const discordClientId = environment.VITE_DISCORD_CLIENT_ID?.trim();

  if (mode === "discord" && !discordClientId) {
    throw new RuntimeConfigurationError(
      "VITE_DISCORD_CLIENT_ID is required in Discord Activity mode.",
    );
  }

  return {
    mode,
    ...(discordClientId ? { discordClientId } : {}),
    apiBaseUrl: normalizeApiBaseUrl(environment.VITE_API_BASE_URL),
    mockActor: {
      id: nonEmptyOr(environment.VITE_MOCK_ACTOR_ID, "mock-player-1"),
      displayName: nonEmptyOr(
        environment.VITE_MOCK_DISPLAY_NAME,
        "Local Player",
      ),
    },
  };
}

export function readBrowserRuntimeConfig(): RuntimeConfig {
  const meta = import.meta as ImportMeta & {
    readonly env?: RuntimeEnvironment;
  };

  return readRuntimeConfig(window.location.search, meta.env);
}
