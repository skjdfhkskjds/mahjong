import type { CanonicalGameStateV2 } from "@mahjong/rules-hong-kong";
import type { BotWorkChanges } from "./table-bot-work.js";
import {
  controlsAfterPresence,
  prepareControllerWork,
  preparePlayerSubstitution,
  type ControllerSnapshot,
} from "./table-controller-application.js";
import type { GameDeadlineChanges } from "./table-game-scheduling.js";
import type {
  PresenceChanges,
  PresenceObservation,
  PresenceState,
} from "./table-presence-application.js";
/** Access operations run within the caller's serialized preparation/commit turn. */
export interface AccessActor {
  readonly id: string;
  readonly displayName: string;
}

export interface AccessBindingAuthorization {
  readonly instanceId: string;
  readonly bindingGeneration: number;
  readonly bindingProof: string;
}

export interface AccessTable extends AccessBindingAuthorization {
  readonly tableId: string;
  readonly ownerActorId: string;
  readonly bindingOperationId: string;
}

export interface AccessResult {
  readonly status: number;
  readonly body: unknown;
}

export interface AccessReceipt {
  readonly requestJson: string;
  readonly status: "pending" | "applied" | "rejected";
  readonly result: AccessResult | undefined;
}

export interface AccessCapability {
  readonly kind: "invitation" | "resume";
  readonly subjectActorId: string;
  readonly secretHash: string;
  readonly expectedBindingGeneration: number;
  readonly expiresAt: number;
  readonly consumedActorId: string | null;
  readonly consumedOperationId: string | null;
}

interface BindingCompletion {
  readonly kind: "complete-binding";
  readonly operationId: string;
  readonly result: AccessResult;
  readonly status: "applied" | "rejected";
  readonly now: number;
  readonly change:
    | { readonly kind: "none" }
    | {
        readonly kind: "create";
        readonly table: AccessTable;
        readonly actor: AccessActor;
      }
    | {
        readonly kind: "resume";
        readonly table: AccessTable;
        readonly capabilityId: string;
      };
}

export type AccessCommit =
  | {
      readonly kind: "admit-binding";
      readonly operationId: string;
      readonly requestJson: string;
      readonly now: number;
    }
  | BindingCompletion
  | {
      readonly kind: "issue-capability";
      readonly capabilityId: string;
      readonly capability: AccessCapability;
    }
  | {
      readonly kind: "redeem-invitation";
      readonly capabilityId: string;
      readonly actor: AccessActor;
      readonly addMember: boolean;
      readonly now: number;
    }
  | {
      readonly kind: "activate-session";
      readonly presence?: PresenceChanges;
      readonly gameDeadlines?: GameDeadlineChanges;
      readonly botWork?: BotWorkChanges;
      readonly publicTransition?: boolean;
      readonly actorId: string;
      readonly sessionGeneration: number;
      readonly now: number;
    };

export type AccessCommitOutcome =
  { readonly kind: "committed" } | { readonly kind: "conflict" };

/** The adapter applies whole operations; it never decides permission or retry policy. */
export interface TableAccessStore {
  controllerSnapshot(): ControllerSnapshot;
  presenceState(): PresenceState;
  table(): AccessTable | undefined;
  receipt(operationId: string): AccessReceipt | undefined;
  capability(capabilityId: string): AccessCapability | undefined;
  sessionGeneration(actorId: string): number | undefined;
  memberRole(actorId: string): "owner" | "member" | undefined;
  commit(change: AccessCommit): AccessCommitOutcome;
}

export interface PreparedBindingRequest {
  readonly actor: AccessActor;
  readonly deadlineAt: number;
  readonly instanceId: string;
  readonly intent:
    | { readonly kind: "create" }
    | {
        readonly kind: "resume";
        readonly capabilityId: string;
        readonly capabilitySecretHash: string;
        readonly tableId: string;
      };
  readonly operationId: string;
}

export function accessProblem(
  status: number,
  code: string,
  message: string,
): AccessResult {
  return { status, body: { error: { code, message } } };
}

export function accessBindingAuthorized(
  authorization: AccessBindingAuthorization,
  table: AccessTable | undefined,
): table is AccessTable {
  return (
    table?.instanceId === authorization.instanceId &&
    table.bindingGeneration === authorization.bindingGeneration &&
    table.bindingProof === authorization.bindingProof
  );
}

function bindingResult(table: AccessTable): AccessResult {
  return {
    status: 200,
    body: {
      version: 1,
      tableId: table.tableId,
      bindingGeneration: table.bindingGeneration,
      bindingProof: table.bindingProof,
      role: "owner",
    },
  };
}

function invalidCapability(): AccessResult {
  return accessProblem(403, "invalid-capability", "The capability is invalid.");
}

function staleSession(): AccessResult {
  return accessProblem(
    409,
    "stale-session-generation",
    "The application session is no longer current.",
  );
}

function finishBinding(
  store: TableAccessStore,
  request: PreparedBindingRequest,
  now: number,
  result: AccessResult,
  change: BindingCompletion["change"] = { kind: "none" },
): AccessResult {
  const outcome = store.commit({
    kind: "complete-binding",
    operationId: request.operationId,
    now,
    result,
    status:
      result.status >= 200 && result.status < 300 ? "applied" : "rejected",
    change,
  });
  if (outcome.kind !== "committed") {
    throw new Error("Binding completion violated caller serialization.");
  }
  return result;
}

/** Admission is durable before execution; final state and receipt commit together.
 * Legacy pending receipts recover even after their deadline if binding committed.
 */
export function applyAccessBinding(
  store: TableAccessStore,
  request: PreparedBindingRequest,
  input: {
    readonly tableId: string;
    readonly now: number;
    readonly bindingProof: string;
  },
): AccessResult {
  const { tableId, now, bindingProof } = input;
  if (request.intent.kind === "resume" && request.intent.tableId !== tableId)
    return invalidCapability();
  // Keep the historical receipt encoding byte-for-byte stable for retry recovery.
  const requestJson = JSON.stringify({
    actor: request.actor,
    deadlineAt: request.deadlineAt,
    instanceId: request.instanceId,
    intent:
      request.intent.kind === "create"
        ? { kind: "create" }
        : {
            kind: "resume",
            capabilityId: request.intent.capabilityId,
            capabilitySecretHash: request.intent.capabilitySecretHash,
            tableId: request.intent.tableId,
          },
    operationId: request.operationId,
    version: 1,
  });
  const receipt = store.receipt(request.operationId);
  const table = store.table();
  if (receipt !== undefined) {
    if (receipt.requestJson !== requestJson)
      return accessProblem(
        409,
        "operation-collision",
        "The operation identifier was already used for different input.",
      );
    if (receipt.status !== "pending" && receipt.result !== undefined)
      return receipt.result;
    if (
      request.deadlineAt <= now &&
      table?.bindingOperationId !== request.operationId
    )
      return finishBinding(
        store,
        request,
        now,
        accessProblem(
          410,
          "binding-expired",
          "The pending binding operation expired before it committed.",
        ),
      );
  } else {
    if (request.deadlineAt <= now)
      return accessProblem(
        410,
        "binding-expired",
        "The binding operation expired before it was admitted.",
      );
    if (
      store.commit({
        kind: "admit-binding",
        operationId: request.operationId,
        requestJson,
        now,
      }).kind !== "committed"
    )
      throw new Error("Binding admission violated caller serialization.");
  }
  if (table?.bindingOperationId === request.operationId)
    return finishBinding(store, request, now, bindingResult(table));
  if (request.intent.kind === "create") {
    if (table !== undefined)
      return finishBinding(
        store,
        request,
        now,
        accessProblem(
          409,
          "table-already-created",
          "The table has already been created.",
        ),
      );
    const created: AccessTable = {
      tableId,
      ownerActorId: request.actor.id,
      instanceId: request.instanceId,
      bindingGeneration: 1,
      bindingProof,
      bindingOperationId: request.operationId,
    };
    return finishBinding(store, request, now, bindingResult(created), {
      kind: "create",
      table: created,
      actor: request.actor,
    });
  }
  if (table === undefined)
    return finishBinding(
      store,
      request,
      now,
      accessProblem(404, "table-not-found", "The table does not exist."),
    );
  if (table.ownerActorId !== request.actor.id)
    return finishBinding(
      store,
      request,
      now,
      accessProblem(
        403,
        "resume-not-authorized",
        "Only the table owner may resume this table.",
      ),
    );
  const capability = store.capability(request.intent.capabilityId);
  let rejection: AccessResult | undefined;
  if (
    capability?.kind !== "resume" ||
    capability.subjectActorId !== request.actor.id ||
    capability.secretHash !== request.intent.capabilitySecretHash
  )
    rejection = invalidCapability();
  else if (capability.expiresAt <= now)
    rejection = accessProblem(
      410,
      "capability-expired",
      "The capability has expired.",
    );
  else if (capability.consumedOperationId !== null)
    rejection = accessProblem(
      410,
      "capability-consumed",
      "The capability was already used.",
    );
  else if (capability.expectedBindingGeneration !== table.bindingGeneration)
    rejection = accessProblem(
      409,
      "stale-binding-generation",
      "The table binding changed after the capability was issued.",
    );
  if (rejection !== undefined)
    return finishBinding(store, request, now, rejection);
  const resumed: AccessTable = {
    ...table,
    instanceId: request.instanceId,
    bindingGeneration: table.bindingGeneration + 1,
    bindingProof,
    bindingOperationId: request.operationId,
  };
  return finishBinding(store, request, now, bindingResult(resumed), {
    kind: "resume",
    table: resumed,
    capabilityId: request.intent.capabilityId,
  });
}

export interface AccessCapabilityRequest extends AccessBindingAuthorization {
  readonly actorId: string;
  readonly invitedActorId?: string;
  readonly sessionGeneration: number;
}

export function issueAccessCapability(
  store: TableAccessStore,
  request: AccessCapabilityRequest,
  input: {
    readonly kind: "invitation" | "resume";
    readonly capabilityId: string;
    readonly secret: string;
    readonly secretHash: string;
    readonly now: number;
  },
): AccessResult {
  const table = store.table();
  if (
    !accessBindingAuthorized(request, table) ||
    table.ownerActorId !== request.actorId
  )
    return accessProblem(
      403,
      "capability-not-authorized",
      "The capability request is not authorized.",
    );
  if (store.sessionGeneration(request.actorId) !== request.sessionGeneration)
    return staleSession();
  const subjectActorId =
    input.kind === "invitation" ? request.invitedActorId : request.actorId;
  if (
    subjectActorId === undefined ||
    (input.kind === "invitation" && subjectActorId === table.ownerActorId)
  )
    return accessProblem(
      400,
      "invalid-capability-subject",
      "The capability subject is invalid.",
    );
  const expiresAt = input.now + 15 * 60 * 1_000;
  const outcome = store.commit({
    kind: "issue-capability",
    capabilityId: input.capabilityId,
    capability: {
      kind: input.kind,
      subjectActorId,
      secretHash: input.secretHash,
      expectedBindingGeneration: table.bindingGeneration,
      expiresAt,
      consumedActorId: null,
      consumedOperationId: null,
    },
  });
  if (outcome.kind !== "committed")
    throw new Error("Capability issuance violated caller serialization.");
  return {
    status: 200,
    body: {
      version: 1,
      capability: `v1.${table.tableId}.${input.capabilityId}.${input.secret}`,
      expiresAt,
    },
  };
}

export interface AccessInvitationRequest extends AccessBindingAuthorization {
  readonly actor: AccessActor;
  readonly sessionGeneration: number;
  readonly now: number;
}

export interface AccessInvitationResult {
  readonly result: AccessResult;
  readonly publishSnapshots: boolean;
}

export function redeemAccessInvitation(
  store: TableAccessStore,
  request: AccessInvitationRequest,
  input: {
    readonly tableId: string;
    readonly capabilityId: string;
    readonly secretHash: string;
    readonly now: number;
  },
): AccessInvitationResult {
  const reject = (result: AccessResult): AccessInvitationResult => ({
    result,
    publishSnapshots: false,
  });
  const table = store.table();
  if (!accessBindingAuthorized(request, table))
    return reject(
      accessProblem(
        409,
        "stale-binding",
        "The table binding is no longer active.",
      ),
    );
  if (input.tableId !== table.tableId) return reject(invalidCapability());
  if (store.sessionGeneration(request.actor.id) !== request.sessionGeneration)
    return reject(staleSession());
  const capability = store.capability(input.capabilityId);
  if (
    capability?.kind !== "invitation" ||
    capability.subjectActorId !== request.actor.id ||
    capability.secretHash !== input.secretHash
  )
    return reject(invalidCapability());
  if (capability.expectedBindingGeneration !== table.bindingGeneration)
    return reject(
      accessProblem(
        409,
        "stale-binding-generation",
        "The table binding changed after the capability was issued.",
      ),
    );
  if (capability.expiresAt <= request.now || capability.expiresAt <= input.now)
    return reject(
      accessProblem(410, "capability-expired", "The capability has expired."),
    );
  if (capability.consumedActorId !== null)
    return reject(
      accessProblem(
        410,
        "capability-consumed",
        "The capability was already used.",
      ),
    );
  const addMember = store.memberRole(request.actor.id) === undefined;
  if (
    store.commit({
      kind: "redeem-invitation",
      capabilityId: input.capabilityId,
      actor: request.actor,
      addMember,
      now: input.now,
    }).kind !== "committed"
  )
    throw new Error("Invitation redemption violated caller serialization.");
  return {
    result: {
      status: 200,
      body: { version: 1, tableId: table.tableId, role: "member" },
    },
    publishSnapshots: addMember,
  };
}

export interface AccessSessionRequest extends AccessBindingAuthorization {
  readonly departure?: true;
  readonly actorId: string;
  readonly sessionGeneration: number;
}

export interface AccessSessionResult {
  readonly departed: boolean;
  readonly result: AccessResult;
  readonly replaceActorSockets: string | undefined;
}

export function activateAccessSession(
  store: TableAccessStore,
  request: AccessSessionRequest,
  input: {
    readonly now: number;
    readonly observations: readonly PresenceObservation[];
    readonly game: CanonicalGameStateV2 | undefined;
    readonly createCommandId: () => string;
  },
): AccessSessionResult {
  const { now } = input;
  const reject = (result: AccessResult): AccessSessionResult => ({
    result,
    replaceActorSockets: undefined,
    departed: false,
  });
  const table = store.table();
  if (table === undefined)
    return reject(
      accessProblem(
        400,
        "invalid-session-request",
        "The session activation request is invalid.",
      ),
    );
  if (!accessBindingAuthorized(request, table))
    return reject(
      accessProblem(
        409,
        "stale-binding",
        "The table binding is no longer active.",
      ),
    );
  if (request.actorId.startsWith("bot:")) {
    return reject(
      accessProblem(
        403,
        "session-not-authorized",
        "Bot players do not have application sessions.",
      ),
    );
  }
  const active = store.sessionGeneration(request.actorId);
  if (active !== undefined && active > request.sessionGeneration)
    return reject(
      accessProblem(
        409,
        "stale-session-generation",
        "A newer application session is already active.",
      ),
    );
  const presence = store.presenceState();
  const snapshot = store.controllerSnapshot();
  // Observations were current before promotion; a newer generation invalidates
  // every observed socket belonging to this actor before departure arbitration.
  const hasUsableSocket =
    active === request.sessionGeneration &&
    input.observations.some(
      (observation) =>
        observation.actorId === request.actorId && observation.expiresAt > now,
    );
  const substitution =
    request.departure === true && input.game !== undefined && !hasUsableSocket
      ? preparePlayerSubstitution({
          control: snapshot.controls.find(
            ({ actorId }) => actorId === request.actorId,
          ),
          game: input.game,
          deadlines: presence.deadlines,
          now,
        })
      : undefined;
  const botWork =
    substitution === undefined
      ? undefined
      : prepareControllerWork({
          controls: controlsAfterPresence(
            snapshot.controls,
            substitution.presence,
          ),
          jobs: snapshot.jobs,
          game: input.game,
          now,
          abandoned: presence.lifecycle.abandoned,
          createCommandId: input.createCommandId,
        });
  if (
    store.commit({
      kind: "activate-session",
      actorId: request.actorId,
      sessionGeneration: request.sessionGeneration,
      now,
      ...(substitution === undefined
        ? {}
        : {
            presence: substitution.presence,
            gameDeadlines: substitution.gameDeadlines,
            ...(botWork === undefined ? {} : { botWork }),
            publicTransition: true,
          }),
    }).kind !== "committed"
  )
    return reject(staleSession());
  // Invitees need a current generation to redeem even before ACL membership.
  const role = store.memberRole(request.actorId);
  return {
    departed: substitution !== undefined,
    result:
      role === undefined
        ? accessProblem(
            403,
            "session-not-authorized",
            "The session activation is not authorized.",
          )
        : { status: 200, body: { version: 1, active: true, role } },
    replaceActorSockets:
      active === undefined || active < request.sessionGeneration
        ? request.actorId
        : undefined,
  };
}
