import type {
  ActivityActor,
  ActivityContext,
  DiscordAuthorization,
} from "../discord/discord-bridge.js";
import type { ActivityRuntimeMode } from "../../bootstrap/runtime-config.js";

export interface HealthResponse {
  readonly status: "ok";
  readonly mode: ActivityRuntimeMode;
  readonly now: string;
}

export type SessionResponse =
  | {
      readonly authenticated: false;
      readonly mode: ActivityRuntimeMode;
    }
  | {
      readonly authenticated: true;
      readonly mode: ActivityRuntimeMode;
      readonly actor: ActivityActor;
      readonly expiresAt: string;
      readonly csrfToken: string;
    };

export interface AuthenticatedSession {
  readonly mode: ActivityRuntimeMode;
  readonly actor: ActivityActor;
  readonly expiresAt: string;
  readonly csrfToken: string;
}

export interface DiscordExchangeResponse extends AuthenticatedSession {
  readonly mode: "discord";
  readonly accessToken: string;
}

export interface ActivityApi {
  getHealth(signal: AbortSignal): Promise<HealthResponse>;
  getSession(signal: AbortSignal): Promise<SessionResponse>;
  createMockSession(
    displayName: string,
    signal: AbortSignal,
  ): Promise<AuthenticatedSession>;
  exchangeDiscordCode(
    authorization: DiscordAuthorization,
    context: ActivityContext,
    signal: AbortSignal,
  ): Promise<DiscordExchangeResponse>;
}

type Fetch = typeof globalThis.fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMode(value: unknown): ActivityRuntimeMode {
  if (value === "mock" || value === "discord") {
    return value;
  }

  throw new Error("API response has an invalid runtime mode.");
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`API response is missing ${field}.`);
  }

  return value;
}

function readActor(value: unknown): ActivityActor {
  if (!isRecord(value)) {
    throw new Error("API response is missing actor.");
  }

  return {
    id: readNonEmptyString(value["id"], "actor.id"),
    displayName: readNonEmptyString(value["displayName"], "actor.displayName"),
  };
}

function parseAuthenticatedSession(value: unknown): AuthenticatedSession {
  if (!isRecord(value)) {
    throw new Error("Authentication response must be an object.");
  }

  return {
    mode: readMode(value["mode"]),
    actor: readActor(value["actor"]),
    expiresAt: readNonEmptyString(value["expiresAt"], "expiresAt"),
    csrfToken: readNonEmptyString(value["csrfToken"], "csrfToken"),
  };
}

export function parseHealthResponse(value: unknown): HealthResponse {
  if (!isRecord(value) || value["status"] !== "ok") {
    throw new Error("Health response does not report an ok status.");
  }

  return {
    status: "ok",
    mode: readMode(value["mode"]),
    now: readNonEmptyString(value["now"], "now"),
  };
}

export function parseSessionResponse(value: unknown): SessionResponse {
  if (!isRecord(value) || typeof value["authenticated"] !== "boolean") {
    throw new Error("Session response has an invalid authenticated flag.");
  }

  const mode = readMode(value["mode"]);
  if (!value["authenticated"]) {
    return { authenticated: false, mode };
  }

  return {
    authenticated: true,
    mode,
    actor: readActor(value["actor"]),
    expiresAt: readNonEmptyString(value["expiresAt"], "expiresAt"),
    csrfToken: readNonEmptyString(value["csrfToken"], "csrfToken"),
  };
}

export function parseDiscordExchangeResponse(
  value: unknown,
): DiscordExchangeResponse {
  const session = parseAuthenticatedSession(value);
  if (session.mode !== "discord" || !isRecord(value)) {
    throw new Error("Discord exchange response has an invalid mode.");
  }

  return {
    ...session,
    mode: "discord",
    accessToken: readNonEmptyString(value["accessToken"], "accessToken"),
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(
      `Activity API request failed with status ${String(response.status)}.`,
    );
  }

  return response.json() as Promise<unknown>;
}

export class HttpActivityApi implements ActivityApi {
  private readonly apiBaseUrl: string;
  private readonly fetchImplementation: Fetch;
  private csrfToken: string | undefined;

  public constructor(
    apiBaseUrl: string,
    fetchImplementation: Fetch = globalThis.fetch,
  ) {
    this.apiBaseUrl = apiBaseUrl;
    this.fetchImplementation = fetchImplementation;
  }

  public async getHealth(signal: AbortSignal): Promise<HealthResponse> {
    const response = await this.fetchImplementation(
      `${this.apiBaseUrl}/api/health`,
      { credentials: "include", signal },
    );
    return parseHealthResponse(await readJsonResponse(response));
  }

  public async getSession(signal: AbortSignal): Promise<SessionResponse> {
    const response = await this.fetchImplementation(
      `${this.apiBaseUrl}/api/session`,
      { credentials: "include", signal },
    );
    const session = parseSessionResponse(await readJsonResponse(response));
    if (session.authenticated) {
      this.csrfToken = session.csrfToken;
    }
    return session;
  }

  public async createMockSession(
    displayName: string,
    signal: AbortSignal,
  ): Promise<AuthenticatedSession> {
    const response = await this.postJson(
      "/api/auth/mock",
      { displayName },
      signal,
    );
    const session = parseAuthenticatedSession(response);
    if (session.mode !== "mock") {
      throw new Error("Mock authentication response has an invalid mode.");
    }

    this.csrfToken = session.csrfToken;
    return session;
  }

  public async exchangeDiscordCode(
    authorization: DiscordAuthorization,
    context: ActivityContext,
    signal: AbortSignal,
  ): Promise<DiscordExchangeResponse> {
    const response = await this.postJson(
      "/api/auth/discord/exchange",
      { code: authorization.code, instanceId: context.instanceId },
      signal,
    );
    const session = parseDiscordExchangeResponse(response);
    this.csrfToken = session.csrfToken;
    return session;
  }

  public headersForAuthenticatedMutation(): Headers {
    if (!this.csrfToken) {
      throw new Error(
        "An authenticated session is required for this mutation.",
      );
    }

    return new Headers({
      "content-type": "application/json",
      "x-csrf-token": this.csrfToken,
    });
  }

  private async postJson(
    path: string,
    body: object,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchImplementation(
      `${this.apiBaseUrl}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
        signal,
      },
    );
    return readJsonResponse(response);
  }
}
