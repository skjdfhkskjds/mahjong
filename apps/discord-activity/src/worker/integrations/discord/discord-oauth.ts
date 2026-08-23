import type { ApplicationActor } from "../../auth/application-session.js";

const DISCORD_API = "https://discord.com/api/v10";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function exchangeDiscordIdentity(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<{ readonly accessToken: string; readonly actor: ApplicationActor }> {
  const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const token = record(await responseJson(tokenResponse));
  const accessToken = token?.["access_token"];
  if (
    !tokenResponse.ok ||
    typeof accessToken !== "string" ||
    accessToken.length < 1 ||
    accessToken.length > 4_096
  ) {
    throw new Error("Discord OAuth exchange failed.");
  }

  const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const user = record(await responseJson(userResponse));
  const id = user?.["id"];
  const username = user?.["username"];
  const globalName = user?.["global_name"];
  const displayName =
    typeof globalName === "string" && globalName.length > 0
      ? globalName
      : username;
  if (
    !userResponse.ok ||
    typeof id !== "string" ||
    !/^\d{1,32}$/u.test(id) ||
    typeof displayName !== "string" ||
    displayName.length < 1 ||
    displayName.length > 40
  ) {
    throw new Error("Discord user lookup failed.");
  }
  return { accessToken, actor: { displayName, id } };
}
