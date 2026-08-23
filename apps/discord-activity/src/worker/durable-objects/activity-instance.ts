import { DurableObject } from "cloudflare:workers";

import {
  isValidApplicationActor,
  type ApplicationActor,
} from "../auth/application-session.js";
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

interface StoredBindingIntent {
  readonly capabilityDigest?: string;
  readonly kind: "create" | "resume";
}

interface PendingBinding {
  readonly actor: ApplicationActor;
  readonly deadlineAt: number;
  readonly intent: StoredBindingIntent;
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

type BindingAllocation =
  | { readonly binding: BoundActivityTable; readonly state: "bound" }
  | { readonly binding: PendingBinding; readonly state: "pending" }
  | { readonly state: "conflict" }
  | { readonly state: "invalid-binding-state" };

interface StoredSession {
  readonly expiresAt: number;
  readonly generation: number;
  readonly sessionDigest: string;
  readonly version: 1;
}

type SessionProposal =
  | {
      readonly expected: StoredSession | undefined;
      readonly session: StoredSession;
      readonly state: "proposed";
    }
  | { readonly state: "generation-exhausted" }
  | { readonly state: "invalid-session-state" };

type SessionPromotion =
  | { readonly state: "promoted" }
  | { readonly state: "conflict" }
  | { readonly state: "invalid-session-state" };

type SessionRevocation =
  | { readonly state: "revoked" }
  | { readonly state: "generation-exhausted" }
  | { readonly state: "session-invalid" };

interface SessionCredential {
  readonly actorId: string;
  readonly sessionGeneration: number;
  readonly sessionId: string;
}

export type TableMemberRole = "member" | "owner";

type ActivityTableAccess =
  | { readonly access: "join-required" }
  | { readonly access: "member"; readonly role: TableMemberRole };

interface IssuedInstanceSessionFields {
  readonly binding: BoundActivityTable;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly version: 1;
}

export type IssuedInstanceSession = ActivityTableAccess &
  IssuedInstanceSessionFields;

interface ValidatedInstanceSessionFields {
  readonly binding: BoundActivityTable;
  readonly valid: true;
  readonly version: 1;
}

export type ValidatedInstanceSession = ActivityTableAccess &
  ValidatedInstanceSessionFields;

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

function sameIntent(
  left: StoredBindingIntent,
  right: StoredBindingIntent,
): boolean {
  return (
    left.kind === right.kind && left.capabilityDigest === right.capabilityDigest
  );
}

function pendingBinding(value: unknown): PendingBinding | undefined {
  const candidate = record(value);
  const intent = record(candidate?.["intent"]);
  const actor = candidate?.["actor"];
  if (
    candidate?.["version"] !== 1 ||
    candidate["state"] !== "binding" ||
    !isValidApplicationActor(actor) ||
    !Number.isSafeInteger(candidate["deadlineAt"]) ||
    (candidate["deadlineAt"] as number) < 0 ||
    typeof candidate["operationId"] !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(candidate["operationId"]) ||
    typeof candidate["tableId"] !== "string" ||
    !TABLE_ID_PATTERN.test(candidate["tableId"]) ||
    intent === undefined ||
    (intent["kind"] !== "create" && intent["kind"] !== "resume") ||
    (intent["kind"] === "resume" &&
      (typeof intent["capabilityDigest"] !== "string" ||
        !SESSION_ID_PATTERN.test(intent["capabilityDigest"]))) ||
    (intent["kind"] === "create" && intent["capabilityDigest"] !== undefined)
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

function sameBinding(
  left: BoundActivityTable,
  right: BoundActivityTable,
): boolean {
  return (
    left.tableId === right.tableId &&
    left.bindingGeneration === right.bindingGeneration &&
    left.bindingProof === right.bindingProof
  );
}

function sameSession(left: StoredSession, right: StoredSession): boolean {
  return (
    left.expiresAt === right.expiresAt &&
    left.generation === right.generation &&
    left.sessionDigest === right.sessionDigest
  );
}

function tableMemberRole(value: unknown): TableMemberRole | undefined {
  const body = record(value);
  return body?.["version"] === 1 && body["active"] === true
    ? body["role"] === "owner" || body["role"] === "member"
      ? body["role"]
      : undefined
    : undefined;
}

export class ActivityInstance extends DurableObject<Env> {
  private async allocateBinding(
    candidate: PendingBinding,
  ): Promise<BindingAllocation> {
    return this.ctx.storage.transaction(async (transaction) => {
      const existingValue = await transaction.get(BINDING_KEY);
      const existing = storedBinding(existingValue);
      if (existingValue !== undefined && existing === undefined) {
        return { state: "invalid-binding-state" };
      }
      if (existing?.state === "bound") {
        return { binding: existing, state: "bound" };
      }
      if (existing !== undefined) {
        return sameIntent(existing.intent, candidate.intent)
          ? { binding: existing, state: "pending" }
          : { state: "conflict" };
      }
      await transaction.put(BINDING_KEY, candidate);
      return { binding: candidate, state: "pending" };
    });
  }

  private sessionGenerationExhausted(): Response {
    return problemResponse(
      500,
      "session-generation-exhausted",
      "The application session generation is exhausted.",
    );
  }

  private async proposeSession(
    key: string,
    expiresAt: number,
    sessionDigest: string,
  ): Promise<SessionProposal> {
    const previousValue = await this.ctx.storage.get(key);
    const previous = storedSession(previousValue);
    if (previousValue !== undefined && previous === undefined) {
      return { state: "invalid-session-state" };
    }
    if (previous?.generation === Number.MAX_SAFE_INTEGER) {
      return { state: "generation-exhausted" };
    }
    return {
      expected: previous,
      session: {
        expiresAt,
        generation: (previous?.generation ?? 0) + 1,
        sessionDigest,
        version: 1,
      },
      state: "proposed",
    };
  }

  private async promoteSession(
    key: string,
    proposal: Extract<SessionProposal, { readonly state: "proposed" }>,
  ): Promise<SessionPromotion> {
    return this.ctx.storage.transaction(async (transaction) => {
      const currentValue = await transaction.get(key);
      const current = storedSession(currentValue);
      if (currentValue !== undefined && current === undefined) {
        return { state: "invalid-session-state" };
      }
      const expectedIsCurrent =
        proposal.expected === undefined
          ? currentValue === undefined
          : current !== undefined && sameSession(current, proposal.expected);
      if (!expectedIsCurrent) return { state: "conflict" };
      await transaction.put(key, proposal.session);
      return { state: "promoted" };
    });
  }

  private async allocateRevocation(
    key: string,
    credential: SessionCredential,
    sessionDigest: string,
  ): Promise<SessionRevocation> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = storedSession(await transaction.get(key));
      if (
        current === undefined ||
        current.expiresAt <= Date.now() ||
        current.generation !== credential.sessionGeneration ||
        current.sessionDigest !== sessionDigest
      ) {
        return { state: "session-invalid" };
      }
      if (current.generation === Number.MAX_SAFE_INTEGER) {
        return { state: "generation-exhausted" };
      }
      const revoked: StoredSession = {
        ...current,
        generation: current.generation + 1,
      };
      await transaction.put(key, revoked);
      return { state: "revoked" };
    });
  }

  private async ensureBinding(
    instanceId: string,
    actor: ApplicationActor,
    resumeCapability?: string,
  ): Promise<BoundActivityTable | Response> {
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
    const intent: StoredBindingIntent = resumeCapability
      ? {
          capabilityDigest: await sha256Base64Url(resumeCapability),
          kind: "resume",
        }
      : { kind: "create" };
    const candidate: PendingBinding = {
      actor,
      deadlineAt: Date.now() + BINDING_DEADLINE_MILLISECONDS,
      intent,
      operationId: crypto.randomUUID(),
      state: "binding",
      tableId: resumedTableId ?? randomBase64Url(16),
      version: 1,
    };
    const allocation = await this.allocateBinding(candidate);
    if (allocation.state === "invalid-binding-state") {
      return problemResponse(
        500,
        "invalid-binding-state",
        "The Activity binding state is invalid.",
      );
    }
    if (allocation.state === "bound") {
      if (resumeCapability !== undefined) {
        return problemResponse(
          409,
          "instance-already-bound",
          "The Activity instance is already bound.",
        );
      }
      return allocation.binding;
    }
    if (allocation.state === "conflict") {
      return problemResponse(
        409,
        "binding-in-progress",
        "A different table binding is already in progress.",
      );
    }
    const pending = allocation.binding;

    let response: Response;
    try {
      response = await this.env.TABLE_ROOM.getByName(pending.tableId).fetch(
        "https://table-room.internal/internal/bindings/apply",
        {
          body: JSON.stringify({
            actor: pending.actor,
            deadlineAt: pending.deadlineAt,
            instanceId,
            intent: resumeCapability
              ? { capability: resumeCapability, kind: "resume" }
              : { kind: "create" },
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
      if ([400, 403, 404, 409, 410].includes(response.status)) {
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
    const currentValue = await this.ctx.storage.get(BINDING_KEY);
    const current = pendingBinding(currentValue);
    if (current?.operationId !== pending.operationId) {
      const currentBound = boundActivityTable(currentValue);
      if (currentBound !== undefined && sameBinding(currentBound, bound)) {
        return currentBound;
      }
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
    const sessionDigest = await sha256Base64Url(credential.sessionId);
    const session = storedSession(
      await this.ctx.storage.get(`${SESSION_KEY_PREFIX}${credential.actorId}`),
    );
    if (
      session === undefined ||
      session.expiresAt <= Date.now() ||
      session.generation !== credential.sessionGeneration ||
      session.sessionDigest !== sessionDigest
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
      !isValidApplicationActor(actor) ||
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
    const sessionId = randomBase64Url(32);
    const proposal = await this.proposeSession(
      key,
      expiresAt as number,
      await sha256Base64Url(sessionId),
    );
    if (proposal.state === "generation-exhausted") {
      return this.sessionGenerationExhausted();
    }
    if (proposal.state === "invalid-session-state") {
      return problemResponse(
        500,
        "invalid-session-state",
        "The application session state is invalid.",
      );
    }
    const session = proposal.session;

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
    const role = activation.ok
      ? tableMemberRole(await responseBody(activation))
      : undefined;
    if (activation.ok && role === undefined) {
      return problemResponse(
        503,
        "invalid-table-response",
        "The table session response is invalid.",
      );
    }
    const promotion = await this.promoteSession(key, proposal);
    if (promotion.state === "invalid-session-state") {
      return problemResponse(
        500,
        "invalid-session-state",
        "The application session state is invalid.",
      );
    }
    if (promotion.state === "conflict") {
      return problemResponse(
        409,
        "session-replaced-concurrently",
        "A concurrent application session replaced this issuance.",
      );
    }
    const issued: IssuedInstanceSession =
      role === undefined
        ? {
            access: "join-required",
            binding: bindingResult,
            sessionGeneration: session.generation,
            sessionId,
            version: 1,
          }
        : {
            access: "member",
            binding: bindingResult,
            role,
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
    const role = activation.ok
      ? tableMemberRole(await responseBody(activation))
      : undefined;
    if (activation.ok && role === undefined) {
      return problemResponse(
        503,
        "invalid-table-response",
        "The table session response is invalid.",
      );
    }
    const result: ValidatedInstanceSession =
      role === undefined
        ? { access: "join-required", binding, valid: true, version: 1 }
        : { access: "member", binding, role, valid: true, version: 1 };
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
    if (validated.session.generation === Number.MAX_SAFE_INTEGER) {
      return this.sessionGenerationExhausted();
    }
    const activation = await this.activateSession(
      instanceId,
      binding,
      validated.credential.actorId,
      validated.session.generation + 1,
    );
    if (!activation.ok && activation.status !== 403) return activation;
    const revocation = await this.allocateRevocation(
      `${SESSION_KEY_PREFIX}${validated.credential.actorId}`,
      validated.credential,
      await sha256Base64Url(validated.credential.sessionId),
    );
    if (revocation.state === "session-invalid") {
      return problemResponse(
        401,
        "session-invalid",
        "The application session is invalid.",
      );
    }
    if (revocation.state === "generation-exhausted") {
      return this.sessionGenerationExhausted();
    }
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
            sessionGeneration: validated.credential.sessionGeneration,
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
    const objectInstanceId = this.ctx.id.name;
    if (
      typeof objectInstanceId !== "string" ||
      !validInstanceId(objectInstanceId) ||
      body["instanceId"] !== objectInstanceId
    ) {
      return problemResponse(
        400,
        "instance-id-mismatch",
        "The Activity instance identifier does not match this object.",
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
        const credential = validSessionCredential(body);
        if (
          !isValidApplicationActor(actor) ||
          actor.id !== credential?.actorId ||
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
              body["instanceId"],
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
