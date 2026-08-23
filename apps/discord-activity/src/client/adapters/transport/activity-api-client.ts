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

export type TableAccess = "member" | "join-required";
export type TableMemberRole = "member" | "owner";

interface AuthenticatedSessionFields {
  readonly authenticated: true;
  readonly mode: ActivityRuntimeMode;
  readonly actor: ActivityActor;
  readonly expiresAt: string;
  readonly csrfToken: string;
  readonly instanceId: string;
  readonly tableId: string;
}

export type AuthenticatedSession = AuthenticatedSessionFields &
  (
    | { readonly access: "join-required" }
    | { readonly access: "member"; readonly role: TableMemberRole }
  );

export type SessionResponse =
  | {
      readonly authenticated: false;
      readonly mode: ActivityRuntimeMode;
    }
  | AuthenticatedSession;

export type DiscordExchangeResponse = AuthenticatedSession & {
  readonly mode: "discord";
  readonly accessToken: string;
};

export interface CapabilityResponse {
  readonly capability: string;
  readonly expiresAt: number;
}

export interface InvitationRedemptionResponse {
  readonly tableId: string;
  readonly role: "member";
}

export class ActivityApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ActivityApiError";
    this.status = status;
    this.code = code;
  }
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
    resumeCapability?: string,
  ): Promise<DiscordExchangeResponse>;
  createInvitation(
    invitedActorId: string,
    signal: AbortSignal,
  ): Promise<CapabilityResponse>;
  redeemInvitation(
    capability: string,
    signal: AbortSignal,
  ): Promise<InvitationRedemptionResponse>;
  createResumeCapability(signal: AbortSignal): Promise<CapabilityResponse>;
  logout(signal: AbortSignal): Promise<void>;
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

function readCapability(value: unknown): string {
  const capability = readNonEmptyString(value, "capability");
  if (
    !/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u.test(
      capability,
    )
  ) {
    throw new Error("Capability response has an invalid capability.");
  }
  return capability;
}

function readTableAccess(value: unknown): TableAccess {
  if (value !== "member" && value !== "join-required") {
    throw new Error("API response has an invalid table access state.");
  }
  return value;
}

function readTableMemberRole(value: unknown): TableMemberRole {
  if (value !== "member" && value !== "owner") {
    throw new Error("API response has an invalid table member role.");
  }
  return value;
}

function readTableId(value: unknown): string {
  const tableId = readNonEmptyString(value, "tableId");
  if (!/^[A-Za-z0-9_-]{22}$/u.test(tableId)) {
    throw new Error("API response has an invalid tableId.");
  }
  return tableId;
}

function readInstanceId(value: unknown): string {
  const instanceId = readNonEmptyString(value, "instanceId");
  if (!/^[^\p{Cc}\p{Cf}]{1,128}$/u.test(instanceId)) {
    throw new Error("API response has an invalid instanceId.");
  }
  return instanceId;
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
  if (!isRecord(value) || value["authenticated"] !== true) {
    throw new Error("Authentication response must be an object.");
  }

  const access = readTableAccess(value["access"]);
  const fields: AuthenticatedSessionFields = {
    authenticated: true,
    mode: readMode(value["mode"]),
    actor: readActor(value["actor"]),
    expiresAt: readNonEmptyString(value["expiresAt"], "expiresAt"),
    csrfToken: readNonEmptyString(value["csrfToken"], "csrfToken"),
    instanceId: readInstanceId(value["instanceId"]),
    tableId: readTableId(value["tableId"]),
  };
  return access === "member"
    ? { ...fields, access, role: readTableMemberRole(value["role"]) }
    : { ...fields, access };
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

  return { ...parseAuthenticatedSession(value), mode };
}

function parseCapabilityResponse(value: unknown): CapabilityResponse {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !Number.isSafeInteger(value["expiresAt"]) ||
    (value["expiresAt"] as number) <= 0
  ) {
    throw new Error("Capability response is invalid.");
  }
  return {
    capability: readCapability(value["capability"]),
    expiresAt: value["expiresAt"] as number,
  };
}

function parseInvitationRedemptionResponse(
  value: unknown,
): InvitationRedemptionResponse {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    value["role"] !== "member"
  ) {
    throw new Error("Invitation redemption response is invalid.");
  }
  return { role: "member", tableId: readTableId(value["tableId"]) };
}

async function apiError(response: Response): Promise<ActivityApiError> {
  let code = "request-failed";
  let message = `Activity API request failed with status ${String(response.status)}.`;
  try {
    const value = (await response.json()) as unknown;
    const error = isRecord(value) ? value["error"] : undefined;
    if (isRecord(error)) {
      if (typeof error["code"] === "string" && error["code"].length > 0) {
        code = error["code"];
      }
      if (typeof error["message"] === "string" && error["message"].length > 0) {
        message = error["message"];
      }
    }
  } catch {
    // Fall back to the stable generic code and message.
  }
  return new ActivityApiError(message, response.status, code);
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
    throw await apiError(response);
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
    } else {
      this.csrfToken = undefined;
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
    resumeCapability?: string,
  ): Promise<DiscordExchangeResponse> {
    const response = await this.postJson(
      "/api/auth/discord/exchange",
      {
        code: authorization.code,
        instanceId: context.instanceId,
        ...(resumeCapability === undefined ? {} : { resumeCapability }),
      },
      signal,
    );
    const session = parseDiscordExchangeResponse(response);
    this.csrfToken = session.csrfToken;
    return session;
  }

  public async createInvitation(
    invitedActorId: string,
    signal: AbortSignal,
  ): Promise<CapabilityResponse> {
    return parseCapabilityResponse(
      await this.postAuthenticatedJson(
        "/api/table/invitations",
        { invitedActorId },
        signal,
      ),
    );
  }

  public async redeemInvitation(
    capability: string,
    signal: AbortSignal,
  ): Promise<InvitationRedemptionResponse> {
    return parseInvitationRedemptionResponse(
      await this.postAuthenticatedJson(
        "/api/table/invitations/redeem",
        { capability },
        signal,
      ),
    );
  }

  public async createResumeCapability(
    signal: AbortSignal,
  ): Promise<CapabilityResponse> {
    return parseCapabilityResponse(
      await this.postAuthenticatedJson(
        "/api/table/resume-capabilities",
        {},
        signal,
      ),
    );
  }

  public async logout(signal: AbortSignal): Promise<void> {
    const response = await this.fetchImplementation(
      `${this.apiBaseUrl}/api/session/logout`,
      {
        method: "POST",
        headers: this.headersForAuthenticatedMutation(),
        credentials: "include",
        body: JSON.stringify({}),
        signal,
      },
    );
    if (!response.ok) throw await apiError(response);
    this.csrfToken = undefined;
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

  private async postAuthenticatedJson(
    path: string,
    body: object,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchImplementation(
      `${this.apiBaseUrl}${path}`,
      {
        method: "POST",
        headers: this.headersForAuthenticatedMutation(),
        credentials: "include",
        body: JSON.stringify(body),
        signal,
      },
    );
    return readJsonResponse(response);
  }
}
