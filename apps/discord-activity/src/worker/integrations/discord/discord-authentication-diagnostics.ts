type AuthenticationStage = "oauth-token" | "oauth-user" | "activity-instance";
type FailureReason =
  | "network-error"
  | "http-error"
  | "invalid-response"
  | "invalid-request"
  | "invalid-client"
  | "invalid-grant";

export function reportDiscordAuthenticationFailure(
  stage: AuthenticationStage,
  reason: FailureReason,
  status?: number,
): void {
  // Never pass request/response objects or caught errors to the logger.
  console.warn({
    event: "discord-authentication-failed",
    stage,
    reason,
    ...(status === undefined ? {} : { status }),
  });
}

export async function fetchDiscordAuthentication(
  stage: AuthenticationStage,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    reportDiscordAuthenticationFailure(stage, "network-error");
    throw new Error("Discord authentication request failed.");
  }
}
