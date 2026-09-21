import {
  assertNewDeadline,
  canonicalDeadlineRequest,
  canonicalJsonValue,
  DEADLINE_ID_PATTERN,
  deadlinePayloadJson,
  isBoundedInteger,
  MAX_DUE_DEADLINE_BATCH,
  MAX_REQUEST_JSON_BYTES,
  MAX_RESULT_JSON_BYTES,
  parseDeadlinePayload,
  parseSystemCommandResult,
  payloadGeneration,
  payloadKind,
  planDeadlineCompletion,
  prepareDeadlineCompletion,
  receiptResultMatchesDeadlineStatus,
  systemCommandResultJson,
  type DeadlineCompletion,
  type DeadlineCompletionState,
  type PendingDeadline,
  type PersistedDeadline,
  type PreparedDeadlineCompletion,
  type SystemCommandReceipt,
  type SystemCommandResult,
} from "./table-deadline-application.js";

export {
  canonicalDeadlineRequest,
  deadlineRaceOrder,
  deadlineTargetsCurrent,
  MAX_DUE_DEADLINE_BATCH,
  planAlarmRepair,
  type AlarmRepairPlan,
  type DeadlineCompletion,
  type DeadlineKind,
  type DeadlinePayload,
  type DeadlineTarget,
  type PendingDeadline,
  type PersistedDeadline,
  type SystemCommandReceipt,
  type SystemCommandResult,
} from "./table-deadline-application.js";

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

/** Loads validated records; application code decides replay or new work. */
export function readDeadlineCompletion(
  sql: SqlStorage,
  deadlineId: string,
): DeadlineCompletionState {
  return {
    deadline: readDeadline(sql, deadlineId),
    receipt: readReceipt(sql, deadlineId),
  };
}

/**
 * Writes the prepared receipt and completion in the enclosing operation's
 * transaction. The caller serializes preparation through commit. This writer
 * checks persistence coherence, including mutation of the selected row by an
 * earlier write in that same operation; it does not decide retry behavior.
 */
export function writeDeadlineCompletionInTransaction(
  sql: SqlStorage,
  prepared: PreparedDeadlineCompletion,
): void {
  const { deadline, receipt } = prepared;
  const stored = readDeadline(sql, deadline.deadlineId);
  if (
    stored?.status !== deadline.status ||
    stored.status === "processed" ||
    stored.dueAt !== deadline.dueAt ||
    canonicalDeadlineRequest({ ...stored, status: "pending" }) !==
      receipt.requestJson ||
    receipt.commandId !== deadline.deadlineId ||
    !isBoundedInteger(receipt.processedAt) ||
    receipt.processedAt < stored.dueAt ||
    systemCommandResultJson(receipt.result) !== receipt.resultJson ||
    !receiptResultMatchesDeadlineStatus(stored, receipt)
  ) {
    throw new Error("Deadline completion lost its pending precondition.");
  }
  sql.exec(
    "INSERT INTO system_command_receipts (command_id, request_json, result_json, processed_at) VALUES (?, ?, ?, ?)",
    receipt.commandId,
    receipt.requestJson,
    receipt.resultJson,
    receipt.processedAt,
  );
  if (stored.status === "pending") {
    sql.exec(
      "UPDATE deadlines SET status = 'processed', processed_at = ? WHERE deadline_id = ?",
      receipt.processedAt,
      deadline.deadlineId,
    );
  }
}

/**
 * Compatibility entry point for existing queue callers. Application operations
 * use the reader and prepared writer through their combined atomic commit.
 */
export function completeDeadlineWithReceipt(
  storage: DurableObjectStorage,
  deadlineId: string,
  processedAt: number,
  apply: (sql: SqlStorage, deadline: PendingDeadline) => SystemCommandResult,
): DeadlineCompletion {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const plan = planDeadlineCompletion(
      { readDeadlineCompletion: (id) => readDeadlineCompletion(sql, id) },
      deadlineId,
      processedAt,
    );
    if (plan.type === "replayed") {
      return { receipt: plan.receipt, replayed: true };
    }
    const prepared =
      plan.type === "complete"
        ? plan.completion
        : prepareDeadlineCompletion(
            plan.deadline,
            processedAt,
            apply(sql, plan.deadline),
          );
    writeDeadlineCompletionInTransaction(sql, prepared);
    return { receipt: prepared.receipt, replayed: false };
  });
}

/** Decodes queue records before they participate in application decisions. */
export function readStoredDeadlines(
  sql: SqlStorage,
): readonly PersistedDeadline[] {
  return sql
    .exec<DeadlineRow>(
      "SELECT deadline_id, kind, due_at, target_generation, payload_json, status, processed_at FROM deadlines ORDER BY deadline_id",
    )
    .toArray()
    .map(parseDeadlineRow);
}

/** Verifies queue/receipt coherence during Durable Object recovery. */
export function verifyDeadlinePersistence(sql: SqlStorage): void {
  const deadlines = readStoredDeadlines(sql);
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
