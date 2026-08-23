import { DurableObject } from "cloudflare:workers";

import type { ApplicationActor } from "../auth/application-session.js";
import type { Env } from "../env.js";
import { jsonResponse, problemResponse } from "../http/responses.js";

const BINDING_KEY = "activity-instance:binding:v1";
const SESSION_KEY_PREFIX = "activity-instance:session:v1:";
const BINDING_DEADLINE_MILLISECONDS = 30_000;
const TABLE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CAPABILITY_PATTERN =
  /^v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/u;
const encoder = new TextEncoder();

interface BindingIntent {
  readonly capability?: string;
  readonly kind: "create" | "resume";
}

interface PendingBinding {
  readonly actor: ApplicationActor;
  readonly deadlineAt: number;
  readonly intent: BindingIntent;
  readonly operationId: string;
  readonly state: "binding";
  readonly tableId: string;
  readonly version: 1;
}

export interface BoundActivityTable {
  readonly bindingGeneration: number;
  readonly bindingProof: string;
  readonly state: "bound";
  readonly tableId: string;
  readonly version: 1;
}

type StoredBinding = PendingBinding | BoundActivityTable;

interface StoredSession {
  readonly expiresAt: number;
  readonly generation: number;
  readonly sessionDigest: string;
  readonly version: 1;
}

interface SessionCredential {
  readonly actorId: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export interface IssuedInstanceSession {
  readonly access: "member" | "join-required";
  readonly binding: BoundActivityTable;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly version: 1;
}

export interface ValidatedInstanceSession {
  readonly binding: BoundActivityTable;
  readonly valid: true;
  readonly version: 1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  try {
    return record(await request.json());
  } catch {
    return undefined;
  }
}

function validActor(value: unknown): value is ApplicationActor {
  const actor = record(value);
  return (
    actor !== undefined &&
    Object.keys(actor).length === 2 &&
    typeof actor["id"] === "string" &&
    actor["id"].length >= 1 &&
    actor["id"].length <= 96 &&
    typeof actor["displayName"] === "string" &&
    actor["displayName"].length >= 1 &&
    actor["displayName"].length <= 40
  );
}

function validInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^[^\p{Cc}\p{Cf}]{1,128}$/u.test(value);
}

function validSessionCredential(
  value: Record<string, unknown>,
): SessionCredential | undefined {
  const actorId = value["actorId"];
  const sessionGeneration = value["sessionGeneration"];
  const sessionId = value["sessionId"];
  if (
    typeof actorId !== "string" ||
    actorId.length < 1 ||
    actorId.length > 96 ||
    !Number.isSafeInteger(sessionGeneration) ||
    (sessionGeneration as number) < 1 ||
    typeof sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) {
    return undefined;
  }
  return { actorId, sessionGeneration: sessionGeneration as number, sessionId };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}

function sameIntent(left: BindingIntent, right: BindingIntent): boolean {
  return left.kind === right.kind && left.capability === right.capability;
}

function pendingBinding(value: unknown): PendingBinding | undefined {
  const candidate = record(value);
  const intent = record(candidate?.["intent"]);
  const actor = candidate?.["actor"];
  if (
    candidate?.["version"] !== 1 ||
    candidate["state"] !== "binding" ||
    !validActor(actor) ||
    !Number.isSafeInteger(candidate["deadlineAt"]) ||
    (candidate["deadlineAt"] as number) < 0 ||
    typeof candidate["operationId"] !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(candidate["operationId"]) ||
    typeof candidate["tableId"] !== "string" ||
    !TABLE_ID_PATTERN.test(candidate["tableId"]) ||
    intent === undefined ||
    (intent["kind"] !== "create" && intent["kind"] !== "resume") ||
    (intent["kind"] === "resume" && typeof intent["capability"] !== "string")
  ) {
    return undefined;
  }
  return candidate as unknown as PendingBinding;
}

function boundActivityTable(value: unknown): BoundActivityTable | undefined {
  const candidate = record(value);
  if (
    candidate?.["version"] !== 1 ||
    candidate["state"] !== "bound" ||
    typeof candidate["tableId"] !== "string" ||
    !TABLE_ID_PATTERN.test(candidate["tableId"]) ||
    !Number.isSafeInteger(candidate["bindingGeneration"]) ||
    (candidate["bindingGeneration"] as number) < 1 ||
    typeof candidate["bindingProof"] !== "string" ||
    !SESSION_ID_PATTERN.test(candidate["bindingProof"])
  ) {
    return undefined;
  }
  return candidate as unknown as BoundActivityTable;
}

function storedBinding(value: unknown): StoredBinding | undefined {
  return pendingBinding(value) ?? boundActivityTable(value);
}

function storedSession(value: unknown): StoredSession | undefined {
  const candidate = record(value);
  if (
    candidate?.["version"] !== 1 ||
    !Number.isSafeInteger(candidate["expiresAt"]) ||
    (candidate["expiresAt"] as number) < 0 ||
    !Number.isSafeInteger(candidate["generation"]) ||
    (candidate["generation"] as number) < 1 ||
    typeof candidate["sessionDigest"] !== "string" ||
    !SESSION_ID_PATTERN.test(candidate["sessionDigest"])
  ) {
    return undefined;
  }
  return candidate as unknown as StoredSession;
}

function tableIdFromCapability(capability: string): string | undefined {
  return CAPABILITY_PATTERN.exec(capability)?.[1];
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    return record(await response.json());
  } catch {
    return undefined;
  }
}

async function responseErrorCode(
  response: Response,
): Promise<string | undefined> {
  const body = await responseBody(response.clone());
  const error = record(body?.["error"]);
  return typeof error?.["code"] === "string" ? error["code"] : undefined;
}

function bindingFromApplyResponse(
  value: unknown,
): BoundActivityTable | undefined {
  const candidate = record(value);
  if (candidate?.["version"] !== 1) return undefined;
  return boundActivityTable({
    bindingGeneration: candidate["bindingGeneration"],
    bindingProof: candidate["bindingProof"],
    state: "bound",
    tableId: candidate["tableId"],
    version: 1,
  });
}

function bindingAuthorization(binding: BoundActivityTable): object {
  return {
    bindingGeneration: binding.bindingGeneration,
    bindingProof: binding.bindingProof,
  };
}

export class ActivityInstance extends DurableObject<Env> {
  private async ensureBinding(
    instanceId: string,
    actor: ApplicationActor,
    resumeCapability?: string,
  ): Promise<BoundActivityTable | Response> {
    const intent: BindingIntent = resumeCapability
      ? { capability: resumeCapability, kind: "resume" }
      : { kind: "create" };
    const existingValue = await this.ctx.storage.get(BINDING_KEY);
    const existing = storedBinding(existingValue);
    if (existingValue !== undefined && existing === undefined) {
      return problemResponse(
        500,
        "invalid-binding-state",
        "The Activity binding state is invalid.",
      );
    }
    if (existing?.state === "bound") {
      if (resumeCapability !== undefined) {
        return problemResponse(
          409,
          "instance-already-bound",
          "The Activity instance is already bound.",
        );
      }
      return existing;
    }

    let pending = existing;
    if (pending !== undefined && !sameIntent(pending.intent, intent)) {
      return problemResponse(
        409,
        "binding-in-progress",
        "A different table binding is already in progress.",
      );
    }
    if (pending === undefined) {
      const resumedTableId = resumeCapability
        ? tableIdFromCapability(resumeCapability)
        : undefined;
      if (resumeCapability && resumedTableId === undefined) {
        return problemResponse(
          400,
          "invalid-resume-capability",
          "The resume capability is invalid.",
        );
      }
      pending = {
        actor,
        deadlineAt: Date.now() + BINDING_DEADLINE_MILLISECONDS,
        intent,
        operationId: crypto.randomUUID(),
        state: "binding",
        tableId: resumedTableId ?? randomBase64Url(16),
        version: 1,
      };
      await this.ctx.storage.put(BINDING_KEY, pending);
    }

    let response: Response;
    try {
      response = await this.env.TABLE_ROOM.getByName(pending.tableId).fetch(
        "https://table-room.internal/internal/bindings/apply",
        {
          body: JSON.stringify({
            actor: pending.actor,
            deadlineAt: pending.deadlineAt,
            instanceId,
            intent: pending.intent,
            operationId: pending.operationId,
            version: 1,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    } catch {
      return problemResponse(
        503,
        "binding-unavailable",
        "The table binding is temporarily unavailable.",
      );
    }
    const body = await responseBody(response);
    if (!response.ok) {
      if ([400, 403, 409, 410].includes(response.status)) {
        const current = pendingBinding(await this.ctx.storage.get(BINDING_KEY));
        if (current?.operationId === pending.operationId) {
          await this.ctx.storage.delete(BINDING_KEY);
        }
      }
      return body === undefined
        ? problemResponse(
            503,
            "binding-unavailable",
            "The table binding is temporarily unavailable.",
          )
        : jsonResponse(body, response.status);
    }
    const bound = bindingFromApplyResponse(body);
    if (bound?.tableId !== pending.tableId) {
      return problemResponse(
        503,
        "invalid-binding-response",
        "The table binding response is invalid.",
      );
    }
    const current = pendingBinding(await this.ctx.storage.get(BINDING_KEY));
    if (current?.operationId !== pending.operationId) {
      return problemResponse(
        409,
        "binding-changed",
        "The Activity binding changed during repair.",
      );
    }
    await this.ctx.storage.put(BINDING_KEY, bound);
    return bound;
  }

  private async validateCredential(value: Record<string, unknown>): Promise<
    | {
        readonly credential: SessionCredential;
        readonly session: StoredSession;
      }
    | undefined
  > {
    const credential = validSessionCredential(value);
    if (credential === undefined) return undefined;
    const session = storedSession(
      await this.ctx.storage.get(`${SESSION_KEY_PREFIX}${credential.actorId}`),
    );
    if (
      session === undefined ||
      session.expiresAt <= Date.now() ||
      session.generation !== credential.sessionGeneration ||
      session.sessionDigest !== (await sha256Base64Url(credential.sessionId))
    ) {
      return undefined;
    }
    return { credential, session };
  }

  private async activateSession(
    instanceId: string,
    binding: BoundActivityTable,
    actorId: string,
    sessionGeneration: number,
  ): Promise<Response> {
    try {
      return await this.env.TABLE_ROOM.getByName(binding.tableId).fetch(
        "https://table-room.internal/internal/sessions/activate",
        {
          body: JSON.stringify({
            actorId,
            ...bindingAuthorization(binding),
            instanceId,
            sessionGeneration,
            version: 1,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    } catch {
      return problemResponse(
        503,
        "table-unavailable",
        "The table is temporarily unavailable.",
      );
    }
  }

  private async issueSession(body: Record<string, unknown>): Promise<Response> {
    const actor = body["actor"];
    const expiresAt = body["expiresAt"];
    const instanceId = body["instanceId"];
    const resumeCapability = body["resumeCapability"];
    if (
      Object.keys(body).some(
        (key) =>
          !["actor", "expiresAt", "instanceId", "resumeCapability"].includes(
            key,
          ),
      ) ||
      !validActor(actor) ||
      !validInstanceId(instanceId) ||
      !Number.isSafeInteger(expiresAt) ||
      (expiresAt as number) <= Date.now() ||
      (expiresAt as number) > Date.now() + 3_660_000 ||
      (resumeCapability !== undefined &&
        (typeof resumeCapability !== "string" || resumeCapability.length > 160))
    ) {
      return problemResponse(
        400,
        "invalid-session-request",
        "The session request is invalid.",
      );
    }

    let bindingResult = await this.ensureBinding(
      instanceId,
      actor,
      resumeCapability,
    );
    if (bindingResult instanceof Response) return bindingResult;

    const key = `${SESSION_KEY_PREFIX}${actor.id}`;
    const previous = storedSession(await this.ctx.storage.get(key));
    const sessionId = randomBase64Url(32);
    const session: StoredSession = {
      expiresAt: expiresAt as number,
      generation: (previous?.generation ?? 0) + 1,
      sessionDigest: await sha256Base64Url(sessionId),
      version: 1,
    };
    await this.ctx.storage.put(key, session);

    let activation = await this.activateSession(
      instanceId,
      bindingResult,
      actor.id,
      session.generation,
    );
    if ((await responseErrorCode(activation)) === "stale-binding") {
      await this.ctx.storage.delete(BINDING_KEY);
      bindingResult = await this.ensureBinding(instanceId, actor);
      if (bindingResult instanceof Response) return bindingResult;
      activation = await this.activateSession(
        instanceId,
        bindingResult,
        actor.id,
        session.generation,
      );
    }
    if (!activation.ok && activation.status !== 403) {
      const activationBody = await responseBody(activation);
      return activationBody === undefined
        ? problemResponse(
            503,
            "table-unavailable",
            "The table is temporarily unavailable.",
          )
        : jsonResponse(activationBody, activation.status);
    }
    const issued: IssuedInstanceSession = {
      access: activation.ok ? "member" : "join-required",
      binding: bindingResult,
      sessionGeneration: session.generation,
      sessionId,
      version: 1,
    };
    return jsonResponse(issued, 201);
  }

  private async validateSession(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const instanceId = body["instanceId"];
    if (!validInstanceId(instanceId)) {
      return problemResponse(
        400,
        "invalid-session-request",
        "The session request is invalid.",
      );
    }
    const validated = await this.validateCredential(body);
    if (validated === undefined) {
      return problemResponse(
        401,
        "session-invalid",
        "The application session is invalid.",
      );
    }
    const bindingValue = await this.ctx.storage.get(BINDING_KEY);
    const binding = boundActivityTable(bindingValue);
    if (binding === undefined) {
      return problemResponse(
        409,
        "instance-unbound",
        "The Activity instance is not bound.",
      );
    }
    const activation = await this.activateSession(
      instanceId,
      binding,
      validated.credential.actorId,
      validated.credential.sessionGeneration,
    );
    const activationError = await responseErrorCode(activation);
    if (activationError === "stale-binding") {
      await this.ctx.storage.delete(BINDING_KEY);
      return problemResponse(
        409,
        "instance-binding-superseded",
        "The Activity instance binding was superseded.",
      );
    }
    if (activationError === "stale-session-generation") {
      return problemResponse(
        401,
        "session-invalid",
        "The application session is invalid.",
      );
    }
    if (!activation.ok && activation.status !== 403) {
      return problemResponse(
        503,
        "table-unavailable",
        "The table is temporarily unavailable.",
      );
    }
    const result: ValidatedInstanceSession = {
      binding,
      valid: true,
      version: 1,
    };
    return jsonResponse(result);
  }

  private async revokeSession(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const validated = await this.validateCredential(body);
    if (validated === undefined) {
      return problemResponse(
        401,
        "session-invalid",
        "The application session is invalid.",
      );
    }
    const binding = boundActivityTable(await this.ctx.storage.get(BINDING_KEY));
    const instanceId = body["instanceId"];
    if (binding === undefined || !validInstanceId(instanceId)) {
      return problemResponse(
        409,
        "instance-unbound",
        "The Activity instance is not bound.",
      );
    }
    const revokedGeneration = validated.session.generation + 1;
    const activation = await this.activateSession(
      instanceId,
      binding,
      validated.credential.actorId,
      revokedGeneration,
    );
    if (!activation.ok) return activation;
    await this.ctx.storage.put(
      `${SESSION_KEY_PREFIX}${validated.credential.actorId}`,
      { ...validated.session, generation: revokedGeneration },
    );
    return new Response(null, { status: 204 });
  }

  private async tableOperation(
    path: string,
    body: Record<string, unknown>,
    extra: Record<string, unknown>,
  ): Promise<Response> {
    const instanceId = body["instanceId"];
    if (!validInstanceId(instanceId)) {
      return problemResponse(
        400,
        "invalid-table-request",
        "The table request is invalid.",
      );
    }
    const validated = await this.validateCredential(body);
    const binding = boundActivityTable(await this.ctx.storage.get(BINDING_KEY));
    if (validated === undefined || binding === undefined) {
      return problemResponse(
        401,
        "session-invalid",
        "The application session is invalid.",
      );
    }
    try {
      return await this.env.TABLE_ROOM.getByName(binding.tableId).fetch(
        `https://table-room.internal${path}`,
        {
          body: JSON.stringify({
            ...(path === "/internal/invitations/redeem"
              ? {}
              : { actorId: validated.credential.actorId }),
            ...bindingAuthorization(binding),
            ...extra,
            instanceId,
            now: Date.now(),
            version: 1,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    } catch {
      return problemResponse(
        503,
        "table-unavailable",
        "The table is temporarily unavailable.",
      );
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return problemResponse(
        405,
        "method-not-allowed",
        "The method is not allowed.",
        {
          Allow: "POST",
        },
      );
    }
    const body = await readJson(request);
    if (body === undefined) {
      return problemResponse(
        400,
        "invalid-json",
        "The request body is invalid.",
      );
    }
    const path = new URL(request.url).pathname;
    switch (path) {
      case "/internal/sessions/issue":
        return this.issueSession(body);
      case "/internal/sessions/validate":
        return this.validateSession(body);
      case "/internal/sessions/revoke":
        return this.revokeSession(body);
      case "/internal/invitations/create": {
        const invitedActorId = body["invitedActorId"];
        if (
          typeof invitedActorId !== "string" ||
          invitedActorId.length < 1 ||
          invitedActorId.length > 96
        ) {
          return problemResponse(
            400,
            "invalid-invitation-request",
            "The invitation request is invalid.",
          );
        }
        return this.tableOperation("/internal/invitations/create", body, {
          invitedActorId,
        });
      }
      case "/internal/invitations/redeem": {
        const actor = body["actor"];
        const capability = body["capability"];
        if (
          !validActor(actor) ||
          typeof capability !== "string" ||
          capability.length > 160
        ) {
          return problemResponse(
            400,
            "invalid-invitation-request",
            "The invitation request is invalid.",
          );
        }
        const response = await this.tableOperation(
          "/internal/invitations/redeem",
          body,
          { actor, capability },
        );
        if (response.ok) {
          const credential = validSessionCredential(body);
          const binding = boundActivityTable(
            await this.ctx.storage.get(BINDING_KEY),
          );
          if (credential && binding) {
            await this.activateSession(
              body["instanceId"] as string,
              binding,
              credential.actorId,
              credential.sessionGeneration,
            );
          }
        }
        return response;
      }
      case "/internal/resume-capabilities/create":
        return this.tableOperation(
          "/internal/resume-capabilities/create",
          body,
          {},
        );
      default:
        return problemResponse(
          404,
          "not-found",
          "The requested resource was not found.",
        );
    }
  }
}
