import {
  createSessionCookie,
  hasValidCsrfToken,
  readApplicationSession,
  type ApplicationActor,
  type ApplicationSession,
} from "./auth/application-session.js";
import {
  activityInstanceTableMutation,
  issueInstanceSession,
  revokeInstanceSession,
  validateInstanceSession,
} from "./auth/activity-instance-session.js";
import type { AuthenticationMode, Env } from "./env.js";
import { hasAllowedOrigin, hasJsonContentType } from "./http/request-policy.js";
import {
  emptyJsonResponse,
  jsonResponse,
  methodNotAllowed,
  problemResponse,
} from "./http/responses.js";
import { exchangeDiscordIdentity } from "./integrations/discord/discord-oauth.js";
import { verifyDiscordActivityInstance } from "./integrations/discord/discord-activity-instance.js";

const DISPLAY_NAME_PATTERN = /^[^\p{Cc}\p{Cf}]{1,40}$/u;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MOCK_ONLY_SIGNING_KEY =
  "mock-mode-only-signing-key-change-before-deployment";
const MOCK_INSTANCE_ID = "standalone-local-instance";
const MAX_PUBLIC_JSON_BODY_BYTES = 4_096;
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
  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > MAX_PUBLIC_JSON_BODY_BYTES
  ) {
    return undefined;
  }
  try {
    if (request.body === null) return undefined;
    const reader = (request.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let body = "";
    let byteLength = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          body += decoder.decode();
          break;
        }
        byteLength += chunk.value.byteLength;
        if (byteLength > MAX_PUBLIC_JSON_BODY_BYTES) {
          await reader.cancel();
          return undefined;
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(body) as unknown;
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

type PublicTableSession =
  | {
      readonly access: "join-required";
      readonly binding: { readonly tableId: string };
    }
  | {
      readonly access: "member";
      readonly binding: { readonly tableId: string };
      readonly role: "member" | "owner";
    };

function publicSession(
  mode: AuthenticationMode,
  session: Awaited<ReturnType<typeof readApplicationSession>>,
  tableSession?: PublicTableSession,
): object {
  if (session === undefined) {
    return { authenticated: false, mode };
  }
  return {
    actor: session.actor,
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
    instanceId: session.instanceId,
    mode,
    ...(tableSession === undefined
      ? {}
      : {
          access: tableSession.access,
          tableId: tableSession.binding.tableId,
          ...(tableSession.access === "member"
            ? { role: tableSession.role }
            : {}),
        }),
  };
}

async function signedSession(
  request: Request,
  env: Env,
  mode: AuthenticationMode,
): Promise<ApplicationSession | undefined> {
  const configuration = sessionConfiguration(env);
  if (configuration === undefined) return undefined;
  const session = await readApplicationSession(
    request,
    env.SESSION_SIGNING_KEY,
    Date.now(),
    configuration,
    env.SESSION_SIGNING_KEY_PREVIOUS,
  );
  return session?.mode === mode ? session : undefined;
}

function authenticatedPolicyFailure(
  request: Request,
  session: ApplicationSession,
): Response | undefined {
  return (
    originRejected(request) ??
    jsonRequired(request) ??
    (hasValidCsrfToken(request, session)
      ? undefined
      : problemResponse(
          403,
          "csrf-token-invalid",
          "The CSRF token is invalid.",
        ))
  );
}

async function hasCurrentInstanceMembership(
  env: Env,
  session: ApplicationSession,
): Promise<boolean> {
  if (session.mode === "mock") return true;
  const applicationId = env.DISCORD_CLIENT_ID;
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!applicationId || !botToken) return false;
  try {
    await verifyDiscordActivityInstance({
      applicationId,
      botToken,
      instanceId: session.instanceId,
      userId: session.actor.id,
    });
    return true;
  } catch {
    return false;
  }
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
  const session = await signedSession(request, env, mode);
  if (session === undefined) {
    return jsonResponse(publicSession(mode, undefined));
  }
  const validated = await validateInstanceSession(env, session);
  return jsonResponse(
    publicSession(
      mode,
      validated === undefined ? undefined : session,
      validated,
    ),
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
  const requestedActor = mockActor(await readJson(request));
  if (requestedActor === undefined) {
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
  const now = Date.now();
  const existing = await readApplicationSession(
    request,
    env.SESSION_SIGNING_KEY,
    now,
    configuration,
    env.SESSION_SIGNING_KEY_PREVIOUS,
  );
  const actor =
    existing?.mode === "mock" &&
    existing.instanceId === MOCK_INSTANCE_ID &&
    existing.actor.displayName === requestedActor.displayName
      ? existing.actor
      : requestedActor;
  const instanceSession = await issueInstanceSession(
    env,
    MOCK_INSTANCE_ID,
    actor,
    now + configuration.lifetimeSeconds * 1_000,
  );
  if (instanceSession === undefined) {
    return problemResponse(
      503,
      "instance-session-unavailable",
      "The Activity instance session is unavailable.",
    );
  }
  if (instanceSession instanceof Response) return instanceSession;
  const created = await createSessionCookie(
    actor,
    {
      instanceId: MOCK_INSTANCE_ID,
      sessionGeneration: instanceSession.sessionGeneration,
      sessionId: instanceSession.sessionId,
    },
    env.SESSION_SIGNING_KEY,
    now,
    configuration,
  );
  const response = jsonResponse(
    publicSession(mode, created.session, instanceSession),
    201,
  );
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
    Object.keys(fields).some(
      (key) => !["code", "instanceId", "resumeCapability"].includes(key),
    ) ||
    typeof fields["code"] !== "string" ||
    fields["code"].length < 1 ||
    fields["code"].length > 1_024 ||
    typeof fields["instanceId"] !== "string" ||
    fields["instanceId"].length < 1 ||
    fields["instanceId"].length > 128 ||
    (fields["resumeCapability"] !== undefined &&
      (typeof fields["resumeCapability"] !== "string" ||
        fields["resumeCapability"].length < 1 ||
        fields["resumeCapability"].length > 160))
  ) {
    return problemResponse(
      400,
      "invalid-request",
      "The Discord authorization body is invalid.",
    );
  }
  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const botToken = env.DISCORD_BOT_TOKEN;
  const configuration = sessionConfiguration(env);
  if (
    clientId === undefined ||
    clientId.length < 1 ||
    clientSecret === undefined ||
    clientSecret.length < 1 ||
    botToken === undefined ||
    botToken.length < 1 ||
    configuration === undefined
  ) {
    return problemResponse(
      503,
      "invalid-configuration",
      "Discord authentication is not configured.",
    );
  }
  let discord: Awaited<ReturnType<typeof exchangeDiscordIdentity>>;
  try {
    discord = await exchangeDiscordIdentity(
      fields["code"],
      clientId,
      clientSecret,
    );
    await verifyDiscordActivityInstance({
      applicationId: clientId,
      botToken,
      instanceId: fields["instanceId"],
      userId: discord.actor.id,
    });
  } catch {
    return problemResponse(
      502,
      "discord-authentication-failed",
      "Discord authentication failed.",
    );
  }
  const now = Date.now();
  const instanceSession = await issueInstanceSession(
    env,
    fields["instanceId"],
    discord.actor,
    now + configuration.lifetimeSeconds * 1_000,
    fields["resumeCapability"],
  );
  if (instanceSession === undefined) {
    return problemResponse(
      503,
      "instance-session-unavailable",
      "The Activity instance session is unavailable.",
    );
  }
  if (instanceSession instanceof Response) return instanceSession;
  const created = await createSessionCookie(
    discord.actor,
    {
      instanceId: fields["instanceId"],
      sessionGeneration: instanceSession.sessionGeneration,
      sessionId: instanceSession.sessionId,
    },
    env.SESSION_SIGNING_KEY,
    now,
    configuration,
  );
  const response = jsonResponse(
    {
      ...publicSession(mode, created.session, instanceSession),
      accessToken: discord.accessToken,
    },
    201,
  );
  response.headers.append("Set-Cookie", created.cookie);
  return response;
}

async function authenticatedMutationSession(
  request: Request,
  env: Env,
  mode: AuthenticationMode,
): Promise<ApplicationSession | Response> {
  const session = await signedSession(request, env, mode);
  if (
    session === undefined ||
    (await validateInstanceSession(env, session)) === undefined
  ) {
    return problemResponse(
      401,
      "authentication-required",
      "An application session is required.",
    );
  }
  return authenticatedPolicyFailure(request, session) ?? session;
}

async function logoutSession(
  request: Request,
  env: Env,
  mode: AuthenticationMode,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const authenticated = await authenticatedMutationSession(request, env, mode);
  if (authenticated instanceof Response) return authenticated;
  const body = await readJson(request);
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 0
  ) {
    return problemResponse(
      400,
      "invalid-request",
      "The logout body must be empty.",
    );
  }
  if (!(await revokeInstanceSession(env, authenticated))) {
    return problemResponse(
      503,
      "logout-unavailable",
      "Logout is temporarily unavailable.",
    );
  }
  const attributes =
    mode === "discord"
      ? "Secure; HttpOnly; SameSite=None; Partitioned"
      : "HttpOnly; SameSite=Lax";
  const response = new Response(null, { status: 204 });
  response.headers.set(
    "Set-Cookie",
    `${env.SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; ${attributes}`,
  );
  return response;
}

async function tableCapabilityMutation(
  request: Request,
  env: Env,
  mode: AuthenticationMode,
  operation: "create-invitation" | "redeem-invitation" | "create-resume",
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const authenticated = await authenticatedMutationSession(request, env, mode);
  if (authenticated instanceof Response) return authenticated;
  if (!(await hasCurrentInstanceMembership(env, authenticated))) {
    return problemResponse(
      403,
      "instance-membership-required",
      "Current Activity instance membership is required.",
    );
  }
  const value = await readJson(request);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return problemResponse(
      400,
      "invalid-request",
      "The table request is invalid.",
    );
  }
  const body = value as Record<string, unknown>;
  let path:
    | "/internal/invitations/create"
    | "/internal/invitations/redeem"
    | "/internal/resume-capabilities/create";
  let fields: object;
  switch (operation) {
    case "create-invitation": {
      const invitedActorId = body["invitedActorId"];
      if (
        Object.keys(body).length !== 1 ||
        typeof invitedActorId !== "string" ||
        invitedActorId.length < 1 ||
        invitedActorId.length > 96
      ) {
        return problemResponse(
          400,
          "invalid-request",
          "The invitation request is invalid.",
        );
      }
      path = "/internal/invitations/create";
      fields = { invitedActorId };
      break;
    }
    case "redeem-invitation": {
      const capability = body["capability"];
      if (
        Object.keys(body).length !== 1 ||
        typeof capability !== "string" ||
        capability.length < 1 ||
        capability.length > 160
      ) {
        return problemResponse(
          400,
          "invalid-request",
          "The invitation request is invalid.",
        );
      }
      path = "/internal/invitations/redeem";
      fields = { actor: authenticated.actor, capability };
      break;
    }
    case "create-resume":
      if (Object.keys(body).length !== 0) {
        return problemResponse(
          400,
          "invalid-request",
          "The resume request body must be empty.",
        );
      }
      path = "/internal/resume-capabilities/create";
      fields = {};
      break;
  }
  const response = await activityInstanceTableMutation(
    env,
    authenticated,
    path,
    fields,
  );
  return (
    response ??
    problemResponse(
      503,
      "table-unavailable",
      "The table is temporarily unavailable.",
    )
  );
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
  const configuration = sessionConfiguration(env);
  if (configuration === undefined) {
    return problemResponse(
      503,
      "invalid-configuration",
      "Session configuration is invalid.",
    );
  }
  const session = await signedSession(request, env, env.APP_MODE);
  if (session === undefined) {
    return problemResponse(
      401,
      "authentication-required",
      "An application session is required.",
    );
  }
  const validated = await validateInstanceSession(env, session);
  if (validated === undefined) {
    return problemResponse(
      401,
      "authentication-required",
      "An application session is required.",
    );
  }
  if (!(await hasCurrentInstanceMembership(env, session))) {
    return problemResponse(
      403,
      "instance-membership-required",
      "Current Activity instance membership is required.",
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.set("X-Mahjong-Actor-Id", session.actor.id);
  headers.set("X-Mahjong-Display-Name", session.actor.displayName);
  headers.set(
    "X-Mahjong-Binding-Generation",
    String(validated.binding.bindingGeneration),
  );
  headers.set("X-Mahjong-Binding-Proof", validated.binding.bindingProof);
  headers.set("X-Mahjong-Connection-Generation", crypto.randomUUID());
  headers.set("X-Mahjong-Instance-Id", session.instanceId);
  headers.set("X-Mahjong-Session-Expires-At", String(session.expiresAt));
  headers.set(
    "X-Mahjong-Session-Generation",
    String(session.sessionGeneration),
  );
  headers.set("X-Mahjong-Table-Id", validated.binding.tableId);
  const stub = env.TABLE_ROOM.getByName(validated.binding.tableId);
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
    case "/api/session/logout":
      return logoutSession(request, env, mode);
    case "/api/auth/mock":
      return createMockSession(request, env, mode);
    case "/api/auth/discord/exchange":
      return reserveDiscordExchange(request, env, mode);
    case "/api/table/socket":
      return connectTable(request, env);
    case "/api/table/invitations":
      return tableCapabilityMutation(request, env, mode, "create-invitation");
    case "/api/table/invitations/redeem":
      return tableCapabilityMutation(request, env, mode, "redeem-invitation");
    case "/api/table/resume-capabilities":
      return tableCapabilityMutation(request, env, mode, "create-resume");
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
