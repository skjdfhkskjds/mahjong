export const DEADLINE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/u;
const BOUNDED_ID_PATTERN = /^[^\p{Cc}\p{Cf}]{1,96}$/u;
export const MAX_REQUEST_JSON_BYTES = 4_096;
export const MAX_RESULT_JSON_BYTES = 1_024;

export const MAX_DUE_DEADLINE_BATCH = 64;

type Seat = "east" | "south" | "west" | "north";
type TurnPhase =
  "awaiting-dealer-discard" | "awaiting-discard" | "awaiting-draw";

export type DeadlinePayload =
  | {
      readonly type: "system/reaction-expired";
      readonly openingSequence: number;
      readonly windowId: string;
    }
  | {
      readonly type: "system/turn-expired";
      readonly openingSequence: number;
      readonly phase: TurnPhase;
      readonly seat: Seat;
    }
  | {
      readonly type: "system/disconnect-grace-expired";
      readonly actorId: string;
      readonly connectionGeneration: number;
    }
  | {
      readonly type: "system/table-abandonment-expired";
      readonly roomActivityGeneration: number;
    };

export type DeadlineKind = "abandonment" | "disconnect" | "reaction" | "turn";

export interface PersistedDeadline {
  readonly deadlineId: string;
  readonly dueAt: number;
  readonly kind: DeadlineKind;
  readonly payload: DeadlinePayload;
  readonly processedAt: number | null;
  readonly status: "cancelled" | "pending" | "processed";
  readonly targetGeneration: number;
}

export interface PendingDeadline {
  readonly deadlineId: string;
  readonly dueAt: number;
  readonly kind: DeadlineKind;
  readonly payload: DeadlinePayload;
  readonly status: "pending";
  readonly targetGeneration: number;
}

export interface SystemCommandReceipt {
  readonly commandId: string;
  readonly processedAt: number;
  readonly requestJson: string;
  readonly result: SystemCommandResult;
  readonly resultJson: string;
}

export type SystemCommandResult =
  | {
      readonly outcome: "processed";
      readonly publicTransition: boolean;
    }
  | {
      readonly outcome: "no-op";
      readonly reason:
        "already-resolved" | "cancelled" | "phase-closed" | "stale-target";
    };

export interface DeadlineCompletion {
  readonly receipt: SystemCommandReceipt;
  readonly replayed: boolean;
}

export type AlarmRepairPlan =
  | { readonly action: "delete" }
  | { readonly action: "keep" }
  | { readonly action: "set"; readonly scheduledTime: number };

export type DeadlineTarget =
  | {
      readonly kind: "reaction";
      readonly openingSequence: number;
      readonly targetGeneration: number;
      readonly windowId: string;
    }
  | {
      readonly kind: "turn";
      readonly openingSequence: number;
      readonly phase: TurnPhase;
      readonly seat: Seat;
      readonly targetGeneration: number;
    }
  | {
      readonly actorId: string;
      readonly connectionGeneration: number;
      readonly kind: "disconnect";
      readonly targetGeneration: number;
    }
  | {
      readonly kind: "abandonment";
      readonly roomActivityGeneration: number;
      readonly targetGeneration: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isBoundedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function payloadKind(payload: DeadlinePayload): DeadlineKind {
  switch (payload.type) {
    case "system/reaction-expired":
      return "reaction";
    case "system/turn-expired":
      return "turn";
    case "system/disconnect-grace-expired":
      return "disconnect";
    case "system/table-abandonment-expired":
      return "abandonment";
  }
}

export function payloadGeneration(payload: DeadlinePayload): number {
  switch (payload.type) {
    case "system/reaction-expired":
    case "system/turn-expired":
      return payload.openingSequence;
    case "system/disconnect-grace-expired":
      return payload.connectionGeneration;
    case "system/table-abandonment-expired":
      return payload.roomActivityGeneration;
  }
}

export function parseDeadlinePayload(value: unknown): DeadlinePayload {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Persisted deadline payload is malformed.");
  }
  if (
    value["type"] === "system/reaction-expired" &&
    hasExactKeys(value, ["openingSequence", "type", "windowId"]) &&
    isBoundedInteger(value["openingSequence"]) &&
    typeof value["windowId"] === "string" &&
    BOUNDED_ID_PATTERN.test(value["windowId"])
  ) {
    return {
      openingSequence: value["openingSequence"],
      type: value["type"],
      windowId: value["windowId"],
    };
  }
  if (
    value["type"] === "system/turn-expired" &&
    hasExactKeys(value, ["openingSequence", "phase", "seat", "type"]) &&
    isBoundedInteger(value["openingSequence"]) &&
    (value["phase"] === "awaiting-dealer-discard" ||
      value["phase"] === "awaiting-discard" ||
      value["phase"] === "awaiting-draw") &&
    (value["seat"] === "east" ||
      value["seat"] === "south" ||
      value["seat"] === "west" ||
      value["seat"] === "north")
  ) {
    return {
      openingSequence: value["openingSequence"],
      phase: value["phase"],
      seat: value["seat"],
      type: value["type"],
    };
  }
  if (
    value["type"] === "system/disconnect-grace-expired" &&
    hasExactKeys(value, ["actorId", "connectionGeneration", "type"]) &&
    typeof value["actorId"] === "string" &&
    BOUNDED_ID_PATTERN.test(value["actorId"]) &&
    isBoundedInteger(value["connectionGeneration"])
  ) {
    return {
      actorId: value["actorId"],
      connectionGeneration: value["connectionGeneration"],
      type: value["type"],
    };
  }
  if (
    value["type"] === "system/table-abandonment-expired" &&
    hasExactKeys(value, ["roomActivityGeneration", "type"]) &&
    isBoundedInteger(value["roomActivityGeneration"])
  ) {
    return {
      roomActivityGeneration: value["roomActivityGeneration"],
      type: value["type"],
    };
  }
  throw new Error("Persisted deadline payload is malformed.");
}

export function canonicalJsonValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Operational values must be JSON-safe.");
}

export function deadlinePayloadJson(payload: DeadlinePayload): string {
  const parsed = parseDeadlinePayload(payload);
  const encoded = canonicalJsonValue(parsed);
  if (new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_JSON_BYTES) {
    throw new Error("Deadline payload exceeds the persisted size bound.");
  }
  return encoded;
}

export function assertNewDeadline(deadline: PendingDeadline): void {
  if (
    !DEADLINE_ID_PATTERN.test(deadline.deadlineId) ||
    !isBoundedInteger(deadline.dueAt) ||
    !isBoundedInteger(deadline.targetGeneration) ||
    payloadKind(deadline.payload) !== deadline.kind ||
    payloadGeneration(deadline.payload) !== deadline.targetGeneration
  ) {
    throw new TypeError("Deadline is outside the persisted contract.");
  }
  deadlinePayloadJson(deadline.payload);
}

/** User actions win only the half-open interval before the deadline. */
export function deadlineRaceOrder(
  now: number,
  dueAt: number,
): "deadline-first" | "user-first" {
  if (!isBoundedInteger(now) || !isBoundedInteger(dueAt)) {
    throw new TypeError("Deadline race times are invalid.");
  }
  return now < dueAt ? "user-first" : "deadline-first";
}

export function deadlineTargetsCurrent(
  deadline: PendingDeadline,
  target: DeadlineTarget,
): boolean {
  if (
    deadline.kind !== target.kind ||
    deadline.targetGeneration !== target.targetGeneration
  ) {
    return false;
  }
  switch (target.kind) {
    case "reaction":
      return (
        deadline.payload.type === "system/reaction-expired" &&
        deadline.payload.openingSequence === target.openingSequence &&
        deadline.payload.windowId === target.windowId
      );
    case "turn":
      return (
        deadline.payload.type === "system/turn-expired" &&
        deadline.payload.openingSequence === target.openingSequence &&
        deadline.payload.phase === target.phase &&
        deadline.payload.seat === target.seat
      );
    case "disconnect":
      return (
        deadline.payload.type === "system/disconnect-grace-expired" &&
        deadline.payload.actorId === target.actorId &&
        deadline.payload.connectionGeneration === target.connectionGeneration
      );
    case "abandonment":
      return (
        deadline.payload.type === "system/table-abandonment-expired" &&
        deadline.payload.roomActivityGeneration ===
          target.roomActivityGeneration
      );
  }
}

export function canonicalDeadlineRequest(deadline: PendingDeadline): string {
  assertNewDeadline(deadline);
  const encoded = canonicalJsonValue({
    command: deadline.payload,
    commandId: deadline.deadlineId,
    targetGeneration: deadline.targetGeneration,
    type: "table/system-command",
    version: 1,
  });
  if (new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_JSON_BYTES) {
    throw new Error("System-command request exceeds the persisted size bound.");
  }
  return encoded;
}

export function parseSystemCommandResult(value: unknown): SystemCommandResult {
  if (!isRecord(value)) {
    throw new Error("Persisted system-command result is malformed.");
  }
  if (
    value["outcome"] === "processed" &&
    hasExactKeys(value, ["outcome", "publicTransition"]) &&
    typeof value["publicTransition"] === "boolean"
  ) {
    return {
      outcome: "processed",
      publicTransition: value["publicTransition"],
    };
  }
  if (
    value["outcome"] === "no-op" &&
    hasExactKeys(value, ["outcome", "reason"]) &&
    (value["reason"] === "already-resolved" ||
      value["reason"] === "cancelled" ||
      value["reason"] === "phase-closed" ||
      value["reason"] === "stale-target")
  ) {
    return { outcome: "no-op", reason: value["reason"] };
  }
  throw new Error("Persisted system-command result is malformed.");
}

export function systemCommandResultJson(result: SystemCommandResult): string {
  const parsed = parseSystemCommandResult(result);
  const encoded = canonicalJsonValue(parsed);
  if (new TextEncoder().encode(encoded).byteLength > MAX_RESULT_JSON_BYTES) {
    throw new Error("System-command result exceeds the persisted size bound.");
  }
  return encoded;
}

export function receiptResultMatchesDeadlineStatus(
  deadline: PersistedDeadline,
  receipt: SystemCommandReceipt,
): boolean {
  const cancelledResult =
    receipt.result.outcome === "no-op" && receipt.result.reason === "cancelled";
  return deadline.status === "cancelled" ? cancelledResult : !cancelledResult;
}

/** Keeps an already earlier alarm; otherwise repairs it to the queue head. */
export function planAlarmRepair(
  currentAlarm: number | null,
  earliestPending: number | undefined,
): AlarmRepairPlan {
  if (
    (currentAlarm !== null && !isBoundedInteger(currentAlarm)) ||
    (earliestPending !== undefined && !isBoundedInteger(earliestPending))
  ) {
    throw new TypeError("Alarm repair times are invalid.");
  }
  if (earliestPending === undefined) {
    return currentAlarm === null ? { action: "keep" } : { action: "delete" };
  }
  if (currentAlarm !== null && currentAlarm <= earliestPending) {
    return { action: "keep" };
  }
  return { action: "set", scheduledTime: earliestPending };
}

export interface DeadlineCompletionState {
  readonly deadline: PersistedDeadline | undefined;
  readonly receipt: SystemCommandReceipt | undefined;
}

export interface DeadlineCompletionReader {
  readDeadlineCompletion(deadlineId: string): DeadlineCompletionState;
}

/** Part of the enclosing operation's atomic commit, never a separate write. */
export interface PreparedDeadlineCompletion {
  readonly deadline: PersistedDeadline;
  readonly receipt: SystemCommandReceipt;
}

export type DeadlineCompletionPlan =
  | { readonly type: "replayed"; readonly receipt: SystemCommandReceipt }
  | {
      readonly type: "complete";
      readonly completion: PreparedDeadlineCompletion;
    }
  | { readonly type: "apply"; readonly deadline: PendingDeadline };

/**
 * Read current queue status before preparing authority changes. A bounded due
 * batch is only a selection: processing another item may cancel this one.
 * The caller holds serialization through decision, preparation, and commit.
 */
export function planDeadlineCompletion(
  reader: DeadlineCompletionReader,
  deadlineId: string,
  processedAt: number,
): DeadlineCompletionPlan {
  if (!DEADLINE_ID_PATTERN.test(deadlineId) || !isBoundedInteger(processedAt)) {
    throw new TypeError("System-command completion input is invalid.");
  }
  const { deadline, receipt } = reader.readDeadlineCompletion(deadlineId);
  if (receipt !== undefined) {
    if (
      (deadline?.status !== "processed" && deadline?.status !== "cancelled") ||
      receipt.commandId !== deadlineId ||
      receipt.requestJson !==
        canonicalDeadlineRequest({ ...deadline, status: "pending" }) ||
      receipt.processedAt < deadline.dueAt ||
      (deadline.status === "processed" &&
        receipt.processedAt !== deadline.processedAt) ||
      !receiptResultMatchesDeadlineStatus(deadline, receipt)
    ) {
      throw new Error("System-command receipt diverges from its deadline.");
    }
    return { type: "replayed", receipt };
  }
  if (deadline === undefined || deadline.status === "processed") {
    throw new Error(
      "A system command cannot process a missing or completed deadline.",
    );
  }
  if (deadline.dueAt > processedAt) {
    throw new Error("A system command cannot process before its deadline.");
  }
  if (deadline.status === "cancelled") {
    return {
      type: "complete",
      completion: prepareDeadlineCompletion(deadline, processedAt, {
        outcome: "no-op",
        reason: "cancelled",
      }),
    };
  }
  return { type: "apply", deadline: { ...deadline, status: "pending" } };
}

/** Canonical receipt preparation preserves the historical persisted bytes. */
export function prepareDeadlineCompletion(
  deadline: PendingDeadline | PersistedDeadline,
  processedAt: number,
  result: SystemCommandResult,
): PreparedDeadlineCompletion {
  if (!isBoundedInteger(processedAt)) {
    throw new TypeError("System-command completion input is invalid.");
  }
  if (deadline.status === "processed") {
    throw new Error(
      "A system command cannot process a missing or completed deadline.",
    );
  }
  if (processedAt < deadline.dueAt) {
    throw new Error("A system command cannot process before its deadline.");
  }
  const cancelledResult =
    result.outcome === "no-op" && result.reason === "cancelled";
  if ((deadline.status === "cancelled") !== cancelledResult) {
    throw new Error("Only a cancelled deadline can record cancellation.");
  }
  return {
    deadline: { ...deadline, processedAt: null },
    receipt: {
      commandId: deadline.deadlineId,
      processedAt,
      requestJson: canonicalDeadlineRequest({ ...deadline, status: "pending" }),
      result,
      resultJson: systemCommandResultJson(result),
    },
  };
}
