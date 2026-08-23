import {
  createSessionCookie,
  readApplicationSession,
  type ApplicationActor,
} from "./auth/application-session.js";
import type { AuthenticationMode, Env } from "./env.js";
import { hasAllowedOrigin, hasJsonContentType } from "./http/request-policy.js";
import {
  emptyJsonResponse,
  jsonResponse,
  methodNotAllowed,
  problemResponse,
} from "./http/responses.js";
import { exchangeDiscordIdentity } from "./integrations/discord/discord-oauth.js";

const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const DISPLAY_NAME_PATTERN = /^[^\p{Cc}\p{Cf}]{1,40}$/u;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MOCK_ONLY_SIGNING_KEY =
  "mock-mode-only-signing-key-change-before-deployment";
const textEncoder = new TextEncoder();

function authenticationMode(env: Env): AuthenticationMode | undefined {
  const value: unknown = env.APP_MODE;
  return value === "mock" || value === "discord" ? value : undefined;
}

function originRejected(request: Request): Response | undefined {
  if (!hasAllowedOrigin(request, new URL(request.url).origin)) {
    return problemResponse(
      403,
      "origin-not-allowed",
      "The request origin is not allowed.",
    );
  }
  return undefined;
}

function sessionConfiguration(env: Env):
  | {
      readonly cookieName: string;
      readonly lifetimeSeconds: number;
      readonly mode: AuthenticationMode;
    }
  | undefined {
  const mode = authenticationMode(env);
  const lifetimeSeconds = Number(env.SESSION_TTL_SECONDS);
  if (
    mode === undefined ||
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds < 60 ||
    lifetimeSeconds > 3_600 ||
    !COOKIE_NAME_PATTERN.test(env.SESSION_COOKIE_NAME) ||
    (mode === "discord" && !env.SESSION_COOKIE_NAME.startsWith("__Host-")) ||
    typeof env.SESSION_SIGNING_KEY !== "string" ||
    textEncoder.encode(env.SESSION_SIGNING_KEY).byteLength < 32 ||
    (env.SESSION_SIGNING_KEY_PREVIOUS !== undefined &&
      env.SESSION_SIGNING_KEY_PREVIOUS.length > 0 &&
      textEncoder.encode(env.SESSION_SIGNING_KEY_PREVIOUS).byteLength < 32) ||
    (mode === "discord" && env.SESSION_SIGNING_KEY === MOCK_ONLY_SIGNING_KEY)
  ) {
    return undefined;
  }
  return { cookieName: env.SESSION_COOKIE_NAME, lifetimeSeconds, mode };
}

function jsonRequired(request: Request): Response | undefined {
  if (!hasJsonContentType(request)) {
    return problemResponse(
      415,
      "unsupported-media-type",
      "Content-Type must be application/json.",
    );
  }
  return undefined;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function mockActor(value: unknown): ApplicationActor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 1 ||
    typeof body["displayName"] !== "string"
  ) {
    return undefined;
  }
  const displayName = body["displayName"].trim();
  if (!DISPLAY_NAME_PATTERN.test(displayName)) {
    return undefined;
  }
  return { displayName, id: `mock:${crypto.randomUUID()}` };
}

function publicSession(
  mode: AuthenticationMode,
  session: Awaited<ReturnType<typeof readApplicationSession>>,
): object {
  if (session === undefined) {
    return { authenticated: false, mode };
  }
  return {
    actor: session.actor,
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
    mode,
  };
}

function health(request: Request, mode: AuthenticationMode): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(["GET", "HEAD"]);
  }
  const body = { mode, now: new Date().toISOString(), status: "ok" };
  return request.method === "HEAD"
    ? emptyJsonResponse(200)
    : jsonResponse(body);
}

async function getSession(
  request: Request,
  env: Env,
  mode: AuthenticationMode,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }
  const configuration = sessionConfiguration(env);
  if (configuration === undefined) {
    return problemResponse(
      503,
      "invalid-configuration",
      "Session configuration is invalid.",
    );
  }
  const session = await readApplicationSession(
    request,
    env.SESSION_SIGNING_KEY,
    Date.now(),
    configuration,
    env.SESSION_SIGNING_KEY_PREVIOUS,
  );
  return jsonResponse(
    publicSession(mode, session?.mode === mode ? session : undefined),
  );
}

async function createMockSession(
  request: Request,
  env: Env,
  mode: AuthenticationMode,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  if (mode !== "mock") {
    return problemResponse(
      404,
      "not-found",
      "The requested resource was not found.",
    );
  }
  const policyFailure = originRejected(request) ?? jsonRequired(request);
  if (policyFailure !== undefined) {
    return policyFailure;
  }
  const actor = mockActor(await readJson(request));
  if (actor === undefined) {
    return problemResponse(
      400,
      "invalid-request",
      "The body must contain one displayName string of 1 to 40 visible characters.",
    );
  }
  const configuration = sessionConfiguration(env);
  if (configuration === undefined) {
    return problemResponse(
      503,
      "invalid-configuration",
      "Session configuration is invalid.",
    );
  }
  const created = await createSessionCookie(
    actor,
    env.SESSION_SIGNING_KEY,
    Date.now(),
    configuration,
  );
  const response = jsonResponse(publicSession(mode, created.session), 201);
  response.headers.append("Set-Cookie", created.cookie);
  return response;
}

async function reserveDiscordExchange(
  request: Request,
  env: Env,
  mode: AuthenticationMode,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  if (mode !== "discord") {
    return problemResponse(
      404,
      "not-found",
      "The requested resource was not found.",
    );
  }
  const policyFailure = originRejected(request) ?? jsonRequired(request);
  if (policyFailure !== undefined) {
    return policyFailure;
  }
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return problemResponse(
      400,
      "invalid-request",
      "The Discord authorization body is invalid.",
    );
  }
  const fields = body as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    typeof fields["code"] !== "string" ||
    fields["code"].length < 1 ||
    fields["code"].length > 1_024 ||
    typeof fields["instanceId"] !== "string" ||
    fields["instanceId"].length < 1 ||
    fields["instanceId"].length > 128
  ) {
    return problemResponse(
      400,
      "invalid-request",
      "The Discord authorization body is invalid.",
    );
  }
  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const configuration = sessionConfiguration(env);
  if (
    clientId === undefined ||
    clientId.length < 1 ||
    clientSecret === undefined ||
    clientSecret.length < 1 ||
    configuration === undefined
  ) {
    return problemResponse(
      503,
      "invalid-configuration",
      "Discord authentication is not configured.",
    );
  }
  try {
    const discord = await exchangeDiscordIdentity(
      fields["code"],
      clientId,
      clientSecret,
    );
    const created = await createSessionCookie(
      discord.actor,
      env.SESSION_SIGNING_KEY,
      Date.now(),
      configuration,
    );
    const response = jsonResponse(
      {
        ...publicSession(mode, created.session),
        accessToken: discord.accessToken,
      },
      201,
    );
    response.headers.append("Set-Cookie", created.cookie);
    return response;
  } catch {
    return problemResponse(
      502,
      "discord-authentication-failed",
      "Discord authentication failed.",
    );
  }
}

async function connectTable(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }
  const policyFailure = originRejected(request);
  if (policyFailure !== undefined) {
    return policyFailure;
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return problemResponse(
      426,
      "upgrade-required",
      "A WebSocket upgrade is required.",
      {
        Upgrade: "websocket",
      },
    );
  }
  const tableId = new URL(request.url).searchParams.get("tableId");
  if (tableId === null || !TABLE_ID_PATTERN.test(tableId)) {
    return problemResponse(
      400,
      "invalid-table-id",
      "A valid tableId is required.",
    );
  }
  const configuration = sessionConfiguration(env);
  if (configuration === undefined) {
    return problemResponse(
      503,
      "invalid-configuration",
      "Session configuration is invalid.",
    );
  }
  const session = await readApplicationSession(
    request,
    env.SESSION_SIGNING_KEY,
    Date.now(),
    configuration,
    env.SESSION_SIGNING_KEY_PREVIOUS,
  );
  if (session?.mode !== env.APP_MODE) {
    return problemResponse(
      401,
      "authentication-required",
      "An application session is required.",
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.set("X-Mahjong-Actor-Id", session.actor.id);
  headers.set("X-Mahjong-Display-Name", session.actor.displayName);
  headers.set("X-Mahjong-Connection-Generation", crypto.randomUUID());
  headers.set("X-Mahjong-Session-Expires-At", String(session.expiresAt));
  headers.set("X-Mahjong-Table-Id", tableId);
  const stub = env.TABLE_ROOM.getByName(tableId);
  return stub.fetch(
    new Request("https://table-room.internal/connect", {
      headers,
      method: "GET",
    }),
  );
}

export async function routeRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const mode = authenticationMode(env);
  if (mode === undefined) {
    return problemResponse(
      503,
      "invalid-configuration",
      "Authentication mode is not configured.",
    );
  }

  switch (url.pathname) {
    case "/api/health":
      return health(request, mode);
    case "/api/session":
      return getSession(request, env, mode);
    case "/api/auth/mock":
      return createMockSession(request, env, mode);
    case "/api/auth/discord/exchange":
      return reserveDiscordExchange(request, env, mode);
    case "/api/table/socket":
      return connectTable(request, env);
    default:
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return problemResponse(
          404,
          "not-found",
          "The requested resource was not found.",
        );
      }
      return env.ASSETS.fetch(request);
  }
}
