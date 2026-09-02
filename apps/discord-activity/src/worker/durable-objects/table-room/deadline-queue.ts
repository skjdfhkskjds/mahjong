const DEADLINE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/u;
const BOUNDED_ID_PATTERN = /^[^\p{Cc}\p{Cf}]{1,96}$/u;
const MAX_REQUEST_JSON_BYTES = 4_096;
const MAX_RESULT_JSON_BYTES = 1_024;

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

interface DeadlineRow {
  readonly [key: string]: SqlStorageValue;
  readonly deadline_id: string;
  readonly due_at: number;
  readonly kind: string;
  readonly payload_json: string;
  readonly processed_at: number | null;
  readonly status: string;
  readonly target_generation: number;
}

interface ReceiptRow {
  readonly [key: string]: SqlStorageValue;
  readonly command_id: string;
  readonly processed_at: number;
  readonly request_json: string;
  readonly result_json: string;
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

function isBoundedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function payloadKind(payload: DeadlinePayload): DeadlineKind {
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

function payloadGeneration(payload: DeadlinePayload): number {
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

function parseDeadlinePayload(value: unknown): DeadlinePayload {
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

function canonicalJsonValue(value: unknown): string {
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

function deadlinePayloadJson(payload: DeadlinePayload): string {
  const parsed = parseDeadlinePayload(payload);
  const encoded = canonicalJsonValue(parsed);
  if (new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_JSON_BYTES) {
    throw new Error("Deadline payload exceeds the persisted size bound.");
  }
  return encoded;
}

function parseDeadlineRow(row: DeadlineRow): PersistedDeadline {
  if (
    typeof row.deadline_id !== "string" ||
    !DEADLINE_ID_PATTERN.test(row.deadline_id) ||
    !isBoundedInteger(row.due_at) ||
    !isBoundedInteger(row.target_generation) ||
    (row.status !== "pending" &&
      row.status !== "processed" &&
      row.status !== "cancelled") ||
    (row.processed_at !== null && !isBoundedInteger(row.processed_at))
  ) {
    throw new Error("Persisted deadline row is malformed.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new Error("Persisted deadline payload is not JSON.", {
      cause: error,
    });
  }
  const payload = parseDeadlinePayload(parsed);
  const kind = payloadKind(payload);
  if (
    row.kind !== kind ||
    row.target_generation !== payloadGeneration(payload) ||
    deadlinePayloadJson(payload) !== row.payload_json ||
    (row.status === "processed") !== (row.processed_at !== null)
  ) {
    throw new Error("Persisted deadline row is incoherent.");
  }
  return {
    deadlineId: row.deadline_id,
    dueAt: row.due_at,
    kind,
    payload,
    processedAt: row.processed_at,
    status: row.status,
    targetGeneration: row.target_generation,
  };
}

function assertNewDeadline(deadline: PendingDeadline): void {
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

function readDeadline(
  sql: SqlStorage,
  deadlineId: string,
): PersistedDeadline | undefined {
  const row = sql
    .exec<DeadlineRow>(
      "SELECT deadline_id, kind, due_at, target_generation, payload_json, status, processed_at FROM deadlines WHERE deadline_id = ?",
      deadlineId,
    )
    .toArray()[0];
  return row === undefined ? undefined : parseDeadlineRow(row);
}

/** Inserts once; an identical retry is a no-op and changed input is a collision. */
export function scheduleDeadline(
  sql: SqlStorage,
  deadline: PendingDeadline,
): void {
  assertNewDeadline(deadline);
  const payloadJson = deadlinePayloadJson(deadline.payload);
  const inserted = sql.exec(
    "INSERT INTO deadlines (deadline_id, kind, due_at, target_generation, payload_json, status, processed_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL) ON CONFLICT(deadline_id) DO NOTHING",
    deadline.deadlineId,
    deadline.kind,
    deadline.dueAt,
    deadline.targetGeneration,
    payloadJson,
  );
  if (inserted.rowsWritten === 1) return;
  const existing = readDeadline(sql, deadline.deadlineId);
  if (
    existing?.status !== "pending" ||
    existing.dueAt !== deadline.dueAt ||
    existing.targetGeneration !== deadline.targetGeneration ||
    existing.kind !== deadline.kind ||
    deadlinePayloadJson(existing.payload) !== payloadJson
  ) {
    throw new Error(
      "Deadline identifier was already used for different input.",
    );
  }
}

export function cancelDeadline(sql: SqlStorage, deadlineId: string): boolean {
  if (!DEADLINE_ID_PATTERN.test(deadlineId)) {
    throw new TypeError("Deadline identifier is invalid.");
  }
  return (
    sql.exec(
      "UPDATE deadlines SET status = 'cancelled', processed_at = NULL WHERE deadline_id = ? AND status = 'pending'",
      deadlineId,
    ).rowsWritten === 1
  );
}

export function readDueDeadlines(
  sql: SqlStorage,
  now: number,
  limit = MAX_DUE_DEADLINE_BATCH,
): readonly PendingDeadline[] {
  if (
    !isBoundedInteger(now) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DUE_DEADLINE_BATCH
  ) {
    throw new TypeError("Deadline batch bounds are invalid.");
  }
  return sql
    .exec<DeadlineRow>(
      "SELECT deadline_id, kind, due_at, target_generation, payload_json, status, processed_at FROM deadlines WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, deadline_id LIMIT ?",
      now,
      limit,
    )
    .toArray()
    .map((row) => {
      const deadline = parseDeadlineRow(row);
      if (deadline.status !== "pending") {
        throw new Error("Due-deadline query returned a non-pending row.");
      }
      return { ...deadline, status: "pending" };
    });
}

export function earliestPendingDeadline(sql: SqlStorage): number | undefined {
  const row = sql
    .exec<{ [key: string]: SqlStorageValue; due_at: number }>(
      "SELECT due_at FROM deadlines WHERE status = 'pending' ORDER BY due_at, deadline_id LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) return undefined;
  if (!isBoundedInteger(row.due_at)) {
    throw new Error("Persisted deadline due time is malformed.");
  }
  return row.due_at;
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

function parseSystemCommandResult(value: unknown): SystemCommandResult {
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

function systemCommandResultJson(result: SystemCommandResult): string {
  const parsed = parseSystemCommandResult(result);
  const encoded = canonicalJsonValue(parsed);
  if (new TextEncoder().encode(encoded).byteLength > MAX_RESULT_JSON_BYTES) {
    throw new Error("System-command result exceeds the persisted size bound.");
  }
  return encoded;
}

function parseReceipt(row: ReceiptRow): SystemCommandReceipt {
  if (
    typeof row.command_id !== "string" ||
    !DEADLINE_ID_PATTERN.test(row.command_id) ||
    !isBoundedInteger(row.processed_at) ||
    typeof row.request_json !== "string" ||
    typeof row.result_json !== "string"
  ) {
    throw new Error("Persisted system-command receipt is malformed.");
  }
  if (
    new TextEncoder().encode(row.request_json).byteLength >
      MAX_REQUEST_JSON_BYTES ||
    new TextEncoder().encode(row.result_json).byteLength > MAX_RESULT_JSON_BYTES
  ) {
    throw new Error("Persisted system-command receipt exceeds its size bound.");
  }
  let request: unknown;
  let parsedResult: unknown;
  try {
    request = JSON.parse(row.request_json) as unknown;
    parsedResult = JSON.parse(row.result_json) as unknown;
  } catch (error) {
    throw new Error("Persisted system-command receipt is not JSON.", {
      cause: error,
    });
  }
  const result = parseSystemCommandResult(parsedResult);
  if (
    canonicalJsonValue(request) !== row.request_json ||
    systemCommandResultJson(result) !== row.result_json
  ) {
    throw new Error("Persisted system-command receipt JSON is not canonical.");
  }
  return {
    commandId: row.command_id,
    processedAt: row.processed_at,
    requestJson: row.request_json,
    result,
    resultJson: row.result_json,
  };
}

function readReceipt(
  sql: SqlStorage,
  commandId: string,
): SystemCommandReceipt | undefined {
  const row = sql
    .exec<ReceiptRow>(
      "SELECT command_id, request_json, result_json, processed_at FROM system_command_receipts WHERE command_id = ?",
      commandId,
    )
    .toArray()[0];
  return row === undefined ? undefined : parseReceipt(row);
}

function receiptResultMatchesDeadlineStatus(
  deadline: PersistedDeadline,
  receipt: SystemCommandReceipt,
): boolean {
  const cancelledResult =
    receipt.result.outcome === "no-op" && receipt.result.reason === "cancelled";
  return deadline.status === "cancelled" ? cancelledResult : !cancelledResult;
}

/**
 * Runs one due system command, receipt, and deadline completion atomically.
 * The callback may update room state or use the game-store in-transaction
 * batch writer. A retry returns the original receipt without rerunning it.
 */
export function completeDeadlineWithReceipt(
  storage: DurableObjectStorage,
  deadlineId: string,
  processedAt: number,
  apply: (sql: SqlStorage, deadline: PendingDeadline) => SystemCommandResult,
): DeadlineCompletion {
  if (!DEADLINE_ID_PATTERN.test(deadlineId) || !isBoundedInteger(processedAt)) {
    throw new TypeError("System-command completion input is invalid.");
  }
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const existing = readReceipt(sql, deadlineId);
    const stored = readDeadline(sql, deadlineId);
    if (existing !== undefined) {
      if (
        (stored?.status !== "processed" && stored?.status !== "cancelled") ||
        existing.requestJson !==
          canonicalDeadlineRequest({ ...stored, status: "pending" }) ||
        existing.processedAt < stored.dueAt ||
        !receiptResultMatchesDeadlineStatus(stored, existing)
      ) {
        throw new Error("System-command receipt diverges from its deadline.");
      }
      return { receipt: existing, replayed: true };
    }
    if (stored === undefined || stored.status === "processed") {
      throw new Error(
        "A system command cannot process a missing or completed deadline.",
      );
    }
    if (stored.dueAt > processedAt) {
      throw new Error("A system command cannot process before its deadline.");
    }
    const requestJson = canonicalDeadlineRequest({
      ...stored,
      status: "pending",
    });
    const result =
      stored.status === "cancelled"
        ? ({ outcome: "no-op", reason: "cancelled" } as const)
        : apply(sql, { ...stored, status: "pending" });
    if (
      stored.status === "pending" &&
      result.outcome === "no-op" &&
      result.reason === "cancelled"
    ) {
      throw new Error("Only a cancelled deadline can record cancellation.");
    }
    const resultJson = systemCommandResultJson(result);
    sql.exec(
      "INSERT INTO system_command_receipts (command_id, request_json, result_json, processed_at) VALUES (?, ?, ?, ?)",
      deadlineId,
      requestJson,
      resultJson,
      processedAt,
    );
    if (stored.status === "pending") {
      const updated = sql.exec(
        "UPDATE deadlines SET status = 'processed', processed_at = ? WHERE deadline_id = ? AND status = 'pending'",
        processedAt,
        deadlineId,
      );
      if (updated.rowsWritten !== 1) {
        throw new Error("Deadline completion lost its pending precondition.");
      }
    }
    return {
      receipt: {
        commandId: deadlineId,
        processedAt,
        requestJson,
        result,
        resultJson,
      },
      replayed: false,
    };
  });
}

/** Verifies queue/receipt coherence during Durable Object recovery. */
export function verifyDeadlinePersistence(sql: SqlStorage): void {
  const deadlines = sql
    .exec<DeadlineRow>(
      "SELECT deadline_id, kind, due_at, target_generation, payload_json, status, processed_at FROM deadlines ORDER BY deadline_id",
    )
    .toArray()
    .map(parseDeadlineRow);
  const receipts = sql
    .exec<ReceiptRow>(
      "SELECT command_id, request_json, result_json, processed_at FROM system_command_receipts ORDER BY command_id",
    )
    .toArray()
    .map(parseReceipt);
  const receiptsById = new Map(
    receipts.map((receipt) => [receipt.commandId, receipt]),
  );
  for (const deadline of deadlines) {
    const receipt = receiptsById.get(deadline.deadlineId);
    if (deadline.status === "pending") {
      if (receipt !== undefined)
        throw new Error("A pending deadline has a system receipt.");
      continue;
    }
    if (deadline.status === "cancelled" && receipt === undefined) continue;
    if (
      receipt === undefined ||
      (deadline.status === "processed" &&
        receipt.processedAt !== deadline.processedAt) ||
      receipt.requestJson !==
        canonicalDeadlineRequest({ ...deadline, status: "pending" }) ||
      receipt.processedAt < deadline.dueAt ||
      !receiptResultMatchesDeadlineStatus(deadline, receipt)
    ) {
      throw new Error("A processed deadline diverges from its system receipt.");
    }
    receiptsById.delete(deadline.deadlineId);
  }
  if (receiptsById.size !== 0) {
    throw new Error("A system receipt exists without its deadline.");
  }
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
