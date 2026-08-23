const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_SNOWFLAKE = /^\d{1,32}$/u;
const VERIFICATION_ERROR = "Discord Activity instance verification failed.";

export interface DiscordActivityInstanceVerification {
  readonly applicationId: string;
  readonly botToken: string;
  readonly instanceId: string;
  readonly userId: string;
}

export interface VerifiedDiscordActivityInstance {
  readonly applicationId: string;
  readonly instanceId: string;
  readonly userIds: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function verificationError(): Error {
  return new Error(VERIFICATION_ERROR);
}

function validRequest(request: DiscordActivityInstanceVerification): boolean {
  return (
    DISCORD_SNOWFLAKE.test(request.applicationId) &&
    DISCORD_SNOWFLAKE.test(request.userId) &&
    /^[^\p{Cc}\p{Cf}]{1,128}$/u.test(request.instanceId) &&
    request.botToken.length > 0 &&
    request.botToken.length <= 4_096 &&
    request.botToken.trim() === request.botToken
  );
}

function parseVerifiedInstance(
  value: unknown,
  expected: DiscordActivityInstanceVerification,
): VerifiedDiscordActivityInstance | undefined {
  const instance = record(value);
  const applicationId = instance?.["application_id"];
  const instanceId = instance?.["instance_id"];
  const users = instance?.["users"];
  if (
    applicationId !== expected.applicationId ||
    instanceId !== expected.instanceId ||
    !Array.isArray(users) ||
    !users.every(
      (userId): userId is string =>
        typeof userId === "string" && DISCORD_SNOWFLAKE.test(userId),
    ) ||
    !users.includes(expected.userId)
  ) {
    return undefined;
  }

  return {
    applicationId,
    instanceId,
    userIds: [...users],
  };
}

export async function verifyDiscordActivityInstance(
  request: DiscordActivityInstanceVerification,
): Promise<VerifiedDiscordActivityInstance> {
  if (!validRequest(request)) {
    throw verificationError();
  }

  try {
    const response = await fetch(
      `${DISCORD_API}/applications/${request.applicationId}/activity-instances/${encodeURIComponent(request.instanceId)}`,
      {
        headers: { Authorization: `Bot ${request.botToken}` },
        method: "GET",
      },
    );
    if (!response.ok) {
      throw verificationError();
    }

    const verified = parseVerifiedInstance(await response.json(), request);
    if (verified === undefined) {
      throw verificationError();
    }
    return verified;
  } catch {
    throw verificationError();
  }
}
