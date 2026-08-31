import type { AuthenticationMode } from "../env.js";

const DEFAULT_COOKIE_NAME = "__Host-mahjong_session";
const SESSION_VERSION = 2;
const DEFAULT_SESSION_LIFETIME_SECONDS = 15 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder(undefined, { fatal: true, ignoreBOM: false });
const OPAQUE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const INSTANCE_ID_PATTERN = /^[^\p{Cc}\p{Cf}]{1,128}$/u;
const ACTOR_ID_PATTERN = /^[^\p{Cc}\p{Cf}]{1,96}$/u;
const DISPLAY_NAME_PATTERN = /^[^\p{Cc}\p{Cf}]{1,40}$/u;

export interface ApplicationActor {
  readonly id: string;
  readonly displayName: string;
}

export interface ApplicationSession {
  readonly actor: ApplicationActor;
  readonly csrfToken: string;
  readonly expiresAt: number;
  readonly instanceId: string;
  readonly issuedAt: number;
  readonly mode: AuthenticationMode;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface ApplicationSessionScope {
  readonly instanceId: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface SessionConfiguration {
  readonly cookieName: string;
  readonly lifetimeSeconds: number;
  readonly mode: AuthenticationMode;
}

interface SessionPayload {
  readonly actorId: string;
  readonly csrfToken: string;
  readonly displayName: string;
  readonly expiresAt: number;
  readonly instanceId: string;
  readonly issuedAt: number;
  readonly mode: AuthenticationMode;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly version: 2;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return bytesToBase64Url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).byteLength < 32) {
    throw new TypeError("SESSION_SIGNING_KEY must contain at least 32 bytes.");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

export function isValidApplicationDisplayName(value: unknown): value is string {
  return typeof value === "string" && DISPLAY_NAME_PATTERN.test(value);
}

export function isValidApplicationActor(
  value: unknown,
): value is ApplicationActor {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actor = value as Record<string, unknown>;
  return (
    Object.keys(actor).length === 2 &&
    typeof actor["id"] === "string" &&
    ACTOR_ID_PATTERN.test(actor["id"]) &&
    isValidApplicationDisplayName(actor["displayName"])
  );
}

function validSessionScope(value: unknown): value is ApplicationSessionScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const scope = value as Record<string, unknown>;
  return (
    Object.keys(scope).length === 3 &&
    typeof scope["instanceId"] === "string" &&
    INSTANCE_ID_PATTERN.test(scope["instanceId"]) &&
    Number.isSafeInteger(scope["sessionGeneration"]) &&
    (scope["sessionGeneration"] as number) > 0 &&
    typeof scope["sessionId"] === "string" &&
    OPAQUE_IDENTIFIER_PATTERN.test(scope["sessionId"])
  );
}

function decodePayload(bytes: Uint8Array): SessionPayload | undefined {
  try {
    const value = JSON.parse(decoder.decode(bytes)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const payload = value as Record<string, unknown>;
    const actor = {
      displayName: payload["displayName"],
      id: payload["actorId"],
    };
    if (
      Object.keys(payload).length !== 10 ||
      payload["version"] !== SESSION_VERSION ||
      (payload["mode"] !== "mock" && payload["mode"] !== "discord") ||
      !isValidApplicationActor(actor) ||
      typeof payload["csrfToken"] !== "string" ||
      !OPAQUE_IDENTIFIER_PATTERN.test(payload["csrfToken"]) ||
      typeof payload["instanceId"] !== "string" ||
      !INSTANCE_ID_PATTERN.test(payload["instanceId"]) ||
      typeof payload["sessionId"] !== "string" ||
      !OPAQUE_IDENTIFIER_PATTERN.test(payload["sessionId"]) ||
      !Number.isSafeInteger(payload["sessionGeneration"]) ||
      (payload["sessionGeneration"] as number) <= 0 ||
      !Number.isSafeInteger(payload["issuedAt"]) ||
      !Number.isSafeInteger(payload["expiresAt"]) ||
      (payload["issuedAt"] as number) < 0 ||
      (payload["expiresAt"] as number) <= (payload["issuedAt"] as number) ||
      (payload["expiresAt"] as number) - (payload["issuedAt"] as number) >
        3_600_000
    )
      return undefined;
    return {
      actorId: actor.id,
      csrfToken: payload["csrfToken"],
      displayName: actor.displayName,
      expiresAt: payload["expiresAt"] as number,
      instanceId: payload["instanceId"],
      issuedAt: payload["issuedAt"] as number,
      mode: payload["mode"],
      sessionGeneration: payload["sessionGeneration"] as number,
      sessionId: payload["sessionId"],
      version: SESSION_VERSION,
    };
  } catch {
    return undefined;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function validConfiguration(
  configuration?: Partial<SessionConfiguration>,
): SessionConfiguration {
  const cookieName = configuration?.cookieName ?? DEFAULT_COOKIE_NAME;
  const lifetimeSeconds =
    configuration?.lifetimeSeconds ?? DEFAULT_SESSION_LIFETIME_SECONDS;
  const mode = configuration?.mode ?? "mock";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/u.test(cookieName)) {
    throw new TypeError("Session cookie name is invalid.");
  }
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds < 60 ||
    lifetimeSeconds > 3_600
  ) {
    throw new TypeError(
      "Session lifetime must be between 60 and 3600 seconds.",
    );
  }
  return { cookieName, lifetimeSeconds, mode };
}

export async function createSessionCookie(
  actor: ApplicationActor,
  scope: ApplicationSessionScope,
  secret: string,
  now = Date.now(),
  configuration?: Partial<SessionConfiguration>,
): Promise<{ readonly cookie: string; readonly session: ApplicationSession }> {
  if (!isValidApplicationActor(actor))
    throw new TypeError("Application session actor is invalid.");
  if (!validSessionScope(scope))
    throw new TypeError("Application session scope is invalid.");
  const { cookieName, lifetimeSeconds, mode } =
    validConfiguration(configuration);
  const expiresAt = now + lifetimeSeconds * 1_000;
  const csrfToken = bytesToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const payload: SessionPayload = {
    actorId: actor.id,
    csrfToken,
    displayName: actor.displayName,
    expiresAt,
    instanceId: scope.instanceId,
    issuedAt: now,
    mode,
    sessionGeneration: scope.sessionGeneration,
    sessionId: scope.sessionId,
    version: SESSION_VERSION,
  };
  const encodedPayload = bytesToBase64Url(
    encoder.encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(encodedPayload),
  );
  const token = `${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
  const attributes =
    mode === "discord"
      ? "Secure; HttpOnly; SameSite=None; Partitioned"
      : "HttpOnly; SameSite=Lax";
  return {
    cookie: `${cookieName}=${token}; Path=/; Max-Age=${String(lifetimeSeconds)}; ${attributes}`,
    session: {
      actor,
      csrfToken,
      expiresAt,
      instanceId: scope.instanceId,
      issuedAt: now,
      mode,
      sessionGeneration: scope.sessionGeneration,
      sessionId: scope.sessionId,
    },
  };
}

async function verifies(
  encodedPayload: string,
  signature: Uint8Array,
  secret: string,
): Promise<boolean> {
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    signature,
    encoder.encode(encodedPayload),
  );
}

export async function readApplicationSession(
  request: Request,
  secret: string,
  now = Date.now(),
  configuration?: Pick<SessionConfiguration, "cookieName">,
  previousSecret?: string,
): Promise<ApplicationSession | undefined> {
  const { cookieName } = validConfiguration(configuration);
  const token = cookieValue(request, cookieName);
  if (token === undefined) return undefined;
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [encodedPayload, encodedSignature] = parts;
  if (encodedPayload === undefined || encodedSignature === undefined)
    return undefined;
  const payloadBytes = base64UrlToBytes(encodedPayload);
  const signatureBytes = base64UrlToBytes(encodedSignature);
  if (payloadBytes === undefined || signatureBytes === undefined)
    return undefined;
  const authentic =
    (await verifies(encodedPayload, signatureBytes, secret)) ||
    (previousSecret !== undefined &&
      previousSecret.length > 0 &&
      (await verifies(encodedPayload, signatureBytes, previousSecret)));
  if (!authentic) return undefined;
  const payload = decodePayload(payloadBytes);
  if (
    payload === undefined ||
    payload.expiresAt <= now ||
    payload.issuedAt > now + 60_000
  ) {
    return undefined;
  }
  return {
    actor: { displayName: payload.displayName, id: payload.actorId },
    csrfToken: payload.csrfToken,
    expiresAt: payload.expiresAt,
    instanceId: payload.instanceId,
    issuedAt: payload.issuedAt,
    mode: payload.mode,
    sessionGeneration: payload.sessionGeneration,
    sessionId: payload.sessionId,
  };
}

export function hasValidCsrfToken(
  request: Request,
  session: ApplicationSession,
): boolean {
  return request.headers.get("X-CSRF-Token") === session.csrfToken;
}
