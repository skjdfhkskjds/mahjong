import type {
  ApplicationActor,
  ApplicationSession,
} from "./application-session.js";
import type {
  BoundActivityTable,
  IssuedInstanceSession,
  ValidatedInstanceSession,
} from "../durable-objects/activity-instance.js";
import type { Env } from "../env.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function jsonRecord(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    return record(await response.json());
  } catch {
    return undefined;
  }
}

function boundTable(value: unknown): BoundActivityTable | undefined {
  const binding = record(value);
  if (
    binding?.["version"] !== 1 ||
    binding["state"] !== "bound" ||
    typeof binding["tableId"] !== "string" ||
    !TABLE_ID_PATTERN.test(binding["tableId"]) ||
    !Number.isSafeInteger(binding["bindingGeneration"]) ||
    (binding["bindingGeneration"] as number) < 1 ||
    typeof binding["bindingProof"] !== "string" ||
    !OPAQUE_ID_PATTERN.test(binding["bindingProof"])
  ) {
    return undefined;
  }
  return binding as unknown as BoundActivityTable;
}

function sessionBody(session: ApplicationSession): object {
  return {
    actorId: session.actor.id,
    instanceId: session.instanceId,
    sessionGeneration: session.sessionGeneration,
    sessionId: session.sessionId,
  };
}

async function instanceFetch(
  env: Env,
  instanceId: string,
  path: string,
  body: object,
): Promise<Response> {
  return env.ACTIVITY_INSTANCE.getByName(instanceId).fetch(
    `https://activity-instance.internal${path}`,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
}

export async function issueInstanceSession(
  env: Env,
  instanceId: string,
  actor: ApplicationActor,
  expiresAt: number,
  resumeCapability?: string,
): Promise<IssuedInstanceSession | undefined> {
  let response: Response;
  try {
    response = await instanceFetch(
      env,
      instanceId,
      "/internal/sessions/issue",
      {
        actor,
        expiresAt,
        instanceId,
        ...(resumeCapability ? { resumeCapability } : {}),
      },
    );
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const value = await jsonRecord(response);
  const binding = boundTable(value?.["binding"]);
  if (
    value?.["version"] !== 1 ||
    (value["access"] !== "member" && value["access"] !== "join-required") ||
    binding === undefined ||
    typeof value["sessionId"] !== "string" ||
    !OPAQUE_ID_PATTERN.test(value["sessionId"]) ||
    !Number.isSafeInteger(value["sessionGeneration"]) ||
    (value["sessionGeneration"] as number) < 1
  ) {
    return undefined;
  }
  return {
    access: value["access"],
    binding,
    sessionGeneration: value["sessionGeneration"] as number,
    sessionId: value["sessionId"],
    version: 1,
  };
}

export async function validateInstanceSession(
  env: Env,
  session: ApplicationSession,
): Promise<ValidatedInstanceSession | undefined> {
  let response: Response;
  try {
    response = await instanceFetch(
      env,
      session.instanceId,
      "/internal/sessions/validate",
      sessionBody(session),
    );
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const value = await jsonRecord(response);
  const binding = boundTable(value?.["binding"]);
  if (
    value?.["version"] !== 1 ||
    value["valid"] !== true ||
    binding === undefined
  ) {
    return undefined;
  }
  return { binding, valid: true, version: 1 };
}

export async function revokeInstanceSession(
  env: Env,
  session: ApplicationSession,
): Promise<boolean> {
  try {
    const response = await instanceFetch(
      env,
      session.instanceId,
      "/internal/sessions/revoke",
      sessionBody(session),
    );
    return response.status === 204;
  } catch {
    return false;
  }
}

export async function activityInstanceTableMutation(
  env: Env,
  session: ApplicationSession,
  path:
    | "/internal/invitations/create"
    | "/internal/invitations/redeem"
    | "/internal/resume-capabilities/create",
  body: object,
): Promise<Response | undefined> {
  try {
    return await instanceFetch(env, session.instanceId, path, {
      ...sessionBody(session),
      ...body,
      instanceId: session.instanceId,
    });
  } catch {
    return undefined;
  }
}
