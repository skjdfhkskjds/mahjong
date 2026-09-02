import type { AuthenticationMode } from "../env.js";

const JSON_MEDIA_TYPE = "application/json";
const DISCORD_CLIENT_ID_PATTERN = /^\d{1,32}$/u;

export function hasJsonContentType(request: Request): boolean {
  const value = request.headers.get("Content-Type");
  if (value === null) {
    return false;
  }

  return value.split(";", 1)[0]?.trim().toLowerCase() === JSON_MEDIA_TYPE;
}

function normalizedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function allowedOrigins(configuration: string): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const candidate of configuration.split(",")) {
    const origin = normalizedOrigin(candidate.trim());
    if (origin !== undefined) {
      origins.add(origin);
    }
  }
  return origins;
}

export function hasAllowedOrigin(
  request: Request,
  configuration: string,
): boolean {
  const supplied = request.headers.get("Origin");
  if (supplied === null) {
    return false;
  }

  const origin = normalizedOrigin(supplied);
  return origin !== undefined && allowedOrigins(configuration).has(origin);
}

export function hasExpectedActivityOrigin(
  request: Request,
  mode: AuthenticationMode,
  discordClientId?: string,
): boolean {
  if (mode === "mock") {
    return hasAllowedOrigin(request, new URL(request.url).origin);
  }
  if (
    discordClientId === undefined ||
    !DISCORD_CLIENT_ID_PATTERN.test(discordClientId)
  ) {
    return false;
  }
  return hasAllowedOrigin(
    request,
    `https://${discordClientId}.discordsays.com`,
  );
}
