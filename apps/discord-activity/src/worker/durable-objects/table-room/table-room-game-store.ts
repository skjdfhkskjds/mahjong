import {
  canonicalVersionedEventHashPayload,
  canonicalVersionedGameEventJson,
  canonicalVersionedGameJson,
  decodeCanonicalGameEventJson,
  decodeCanonicalVersionedGameEventJson,
  decodeCanonicalVersionedGameJson,
  reduceVersionedGameEvent,
  upgradeCanonicalGameState,
  type HongKongGameEvent,
  type NonEmptyGameEventBatch,
  type VersionedCanonicalGameState,
  type VersionedHongKongGameEvent,
} from "@mahjong/rules-hong-kong";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

interface CheckpointRow {
  readonly [key: string]: SqlStorageValue;
  readonly last_event_hash: string;
  readonly state_json: string;
}

interface EventRow {
  readonly [key: string]: SqlStorageValue;
  readonly event_hash: string;
  readonly event_json: string;
  readonly previous_hash: string | null;
  readonly sequence: number;
}

export interface PreparedGameEventRow {
  readonly eventHash: string;
  readonly eventJson: string;
  readonly previousHash: string | null;
  readonly sequence: number;
}

export interface PreparedGameEventBatch {
  readonly expectedPreviousHash: string | null;
  readonly expectedPreviousSequence: number;
  readonly finalState: VersionedCanonicalGameState;
  readonly finalStateJson: string;
  readonly lastEventHash: string;
  readonly rows: readonly [PreparedGameEventRow, ...PreparedGameEventRow[]];
}

export interface VerifiedStoredGame {
  readonly events: readonly [
    VersionedHongKongGameEvent,
    ...VersionedHongKongGameEvent[],
  ];
  readonly lastEventHash: string;
  readonly state: VersionedCanonicalGameState;
}

export type EventDigest = (payload: string) => Promise<string>;

const V4_SCHEMA_VERSION = 4;

interface SchemaVersionRow {
  readonly [key: string]: SqlStorageValue;
  readonly schema_version: number;
}

interface ForeignKeyRow {
  readonly [key: string]: SqlStorageValue;
  readonly from: string;
  readonly table: string;
  readonly to: string;
}

async function sha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertDigest(value: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error("The game event digest is not lowercase SHA-256.");
  }
}

function persistedRows(sql: SqlStorage): readonly EventRow[] {
  return sql
    .exec<EventRow>(
      "SELECT sequence, event_json, previous_hash, event_hash FROM game_events ORDER BY sequence",
    )
    .toArray();
}

function persistedCheckpoint(sql: SqlStorage): CheckpointRow | undefined {
  return sql
    .exec<CheckpointRow>(
      "SELECT state_json, last_event_hash FROM canonical_game_state WHERE singleton = 1",
    )
    .toArray()[0];
}

/**
 * Verifies the complete authority-only event chain before trusting its eager
 * checkpoint. Persisted JSON is decoded through the rules package's closed
 * versioned codecs; unknown state or event versions therefore fail closed.
 */
export async function verifyStoredGame(
  sql: SqlStorage,
  digest: EventDigest = sha256Hex,
): Promise<VerifiedStoredGame | undefined> {
  const checkpoint = persistedCheckpoint(sql);
  const rows = persistedRows(sql);
  if (checkpoint === undefined) {
    if (rows.length !== 0) {
      throw new Error("Game events exist without a canonical checkpoint.");
    }
    return undefined;
  }
  const firstRow = rows[0];
  if (firstRow === undefined) {
    throw new Error("Canonical game checkpoint exists without events.");
  }

  let previousHash: string | null = null;
  let state: VersionedCanonicalGameState | undefined;
  const firstEvent = decodeCanonicalVersionedGameEventJson(firstRow.event_json);
  const events: [VersionedHongKongGameEvent, ...VersionedHongKongGameEvent[]] =
    [firstEvent];

  for (const [index, row] of rows.entries()) {
    if (
      !Number.isSafeInteger(row.sequence) ||
      row.sequence !== index + 1 ||
      row.previous_hash !== previousHash ||
      !SHA256_HEX_PATTERN.test(row.event_hash)
    ) {
      throw new Error("Persisted game event chain is non-contiguous.");
    }
    const event =
      index === 0
        ? firstEvent
        : decodeCanonicalVersionedGameEventJson(row.event_json);
    if (event.sequence !== row.sequence) {
      throw new Error("Persisted event sequence does not match its row.");
    }
    const expectedHash = await digest(
      canonicalVersionedEventHashPayload(previousHash, event),
    );
    assertDigest(expectedHash);
    if (expectedHash !== row.event_hash) {
      throw new Error("Persisted game event hash verification failed.");
    }
    state = reduceVersionedGameEvent(state, event);
    previousHash = row.event_hash;
    if (index !== 0) events.push(event);
  }

  const checkpointState = decodeCanonicalVersionedGameJson(
    checkpoint.state_json,
  );
  if (
    state === undefined ||
    previousHash === null ||
    checkpoint.last_event_hash !== previousHash ||
    canonicalVersionedGameJson(state) !==
      canonicalVersionedGameJson(checkpointState)
  ) {
    throw new Error("Canonical game checkpoint diverges from event replay.");
  }
  return { events, lastEventHash: previousHash, state };
}

/** Prepares hashes and the reduced checkpoint before entering SQLite. */
export async function prepareGameEventBatch(
  prior: VerifiedStoredGame | undefined,
  events: NonEmptyGameEventBatch,
  digest: EventDigest = sha256Hex,
): Promise<PreparedGameEventBatch> {
  let state = prior?.state;
  let previousHash = prior?.lastEventHash ?? null;
  const rows: PreparedGameEventRow[] = [];
  for (const event of events) {
    const next = reduceVersionedGameEvent(state, event);
    const eventJson = canonicalVersionedGameEventJson(event);
    const eventHash = await digest(
      canonicalVersionedEventHashPayload(previousHash, event),
    );
    assertDigest(eventHash);
    rows.push({
      eventHash,
      eventJson,
      previousHash,
      sequence: event.sequence,
    });
    previousHash = eventHash;
    state = next;
  }
  const first = rows[0];
  if (first === undefined || state === undefined || previousHash === null) {
    throw new Error("A persisted game batch must be nonempty.");
  }
  return {
    expectedPreviousHash: prior?.lastEventHash ?? null,
    expectedPreviousSequence: prior?.state.sequence ?? 0,
    finalState: state,
    finalStateJson: canonicalVersionedGameJson(state),
    lastEventHash: previousHash,
    rows: [first, ...rows.slice(1)],
  };
}

function assertBatchPrecondition(
  sql: SqlStorage,
  batch: PreparedGameEventBatch,
): void {
  const checkpoint = persistedCheckpoint(sql);
  const tail = sql
    .exec<{
      [key: string]: SqlStorageValue;
      event_hash: string;
      sequence: number;
    }>(
      "SELECT sequence, event_hash FROM game_events ORDER BY sequence DESC LIMIT 1",
    )
    .toArray()[0];
  if (batch.expectedPreviousHash === null) {
    if (checkpoint !== undefined || tail !== undefined) {
      throw new Error("The game persistence precondition is stale.");
    }
    return;
  }
  if (
    checkpoint?.last_event_hash !== batch.expectedPreviousHash ||
    tail?.event_hash !== batch.expectedPreviousHash ||
    tail.sequence !== batch.expectedPreviousSequence
  ) {
    throw new Error("The game persistence precondition is stale.");
  }
}

/**
 * Appends a prepared event batch and its final checkpoint atomically. The
 * optional callback runs inside the same SQLite transaction so TableRoom can
 * persist command receipts, deadline mutations, and room state before publish.
 */
export function persistPreparedGameBatch<Result = void>(
  storage: DurableObjectStorage,
  batch: PreparedGameEventBatch,
  persistRelated?: (sql: SqlStorage) => Result,
): Result | undefined {
  return storage.transactionSync(() => {
    persistPreparedGameBatchInTransaction(storage.sql, batch);
    return persistRelated?.(storage.sql);
  });
}

/** Writes a prepared batch inside an existing TableRoom SQLite transaction. */
export function persistPreparedGameBatchInTransaction(
  sql: SqlStorage,
  batch: PreparedGameEventBatch,
): void {
  assertBatchPrecondition(sql, batch);
  for (const row of batch.rows) {
    sql.exec(
      "INSERT INTO game_events (sequence, event_json, previous_hash, event_hash) VALUES (?, ?, ?, ?)",
      row.sequence,
      row.eventJson,
      row.previousHash,
      row.eventHash,
    );
  }
  sql.exec(
    "INSERT INTO canonical_game_state (singleton, state_json, last_event_hash) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json, last_event_hash = excluded.last_event_hash",
    batch.finalStateJson,
    batch.lastEventHash,
  );
}

function legacyHistory(
  game: VerifiedStoredGame,
): readonly [HongKongGameEvent, ...HongKongGameEvent[]] {
  if (game.state.schemaVersion !== 1) {
    throw new Error("Only a verified canonical schema-v1 game can upgrade.");
  }
  const legacy: HongKongGameEvent[] = [];
  for (const event of game.events) {
    legacy.push(
      decodeCanonicalGameEventJson(canonicalVersionedGameEventJson(event)),
    );
  }
  const first = legacy[0];
  if (first === undefined)
    throw new Error("A legacy game has no genesis event.");
  return [first, ...legacy.slice(1)];
}

/** Builds the sole deterministic hash-preserving v1-to-v2 upgrade batch. */
export async function prepareV1GameUpgrade(
  game: VerifiedStoredGame,
  digest: EventDigest = sha256Hex,
): Promise<PreparedGameEventBatch> {
  const upgraded = upgradeCanonicalGameState(legacyHistory(game));
  const batch = await prepareGameEventBatch(game, [upgraded.event], digest);
  if (
    canonicalVersionedGameJson(batch.finalState) !==
    canonicalVersionedGameJson(upgraded.state)
  ) {
    throw new Error("Prepared upgrade checkpoint diverges from rules replay.");
  }
  return batch;
}

function requireExistingAuthorityTables(sql: SqlStorage): void {
  sql.exec(
    "SELECT table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id FROM table_record LIMIT 0",
  );
  sql.exec(
    "SELECT actor_id, display_name, role, joined_at FROM members LIMIT 0",
  );
  sql.exec(
    "SELECT operation_id, request_json, status, response_json, http_status, created_at, updated_at FROM binding_receipts LIMIT 0",
  );
  sql.exec(
    "SELECT capability_id, kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id FROM capabilities LIMIT 0",
  );
  sql.exec(
    "SELECT actor_id, session_generation, activated_at FROM actor_sessions LIMIT 0",
  );
  sql.exec(
    "SELECT connection_generation, actor_id, display_name, instance_id, table_id, binding_generation, binding_proof, session_generation, expires_at FROM connection_grants LIMIT 0",
  );
}

function requireLobbyTables(sql: SqlStorage): void {
  sql.exec("SELECT state_version FROM lobby_state WHERE singleton = 1").one();
  sql.exec(
    "SELECT seat, actor_id, display_name, ready FROM lobby_seats LIMIT 0",
  );
  sql.exec(
    "SELECT command_id, actor_id, request_json, response_json, created_at FROM lobby_command_receipts LIMIT 0",
  );
}

function requireGameTables(sql: SqlStorage): void {
  sql.exec(
    "SELECT singleton, state_json, last_event_hash FROM canonical_game_state LIMIT 0",
  );
  sql.exec(
    "SELECT sequence, event_json, previous_hash, event_hash FROM game_events LIMIT 0",
  );
}

function requireV4Tables(sql: SqlStorage): void {
  sql.exec(
    "SELECT deadline_id, kind, due_at, target_generation, payload_json, status, processed_at FROM deadlines LIMIT 0",
  );
  sql.exec(
    "SELECT command_id, request_json, result_json, processed_at FROM system_command_receipts LIMIT 0",
  );
  sql
    .exec(
      "SELECT room_activity_generation, abandoned, updated_at FROM room_lifecycle WHERE singleton = 1",
    )
    .one();
  sql.exec(
    "SELECT actor_id, connection_generation, autopilot, updated_at FROM player_automation LIMIT 0",
  );
  const receiptForeignKeys = sql
    .exec<ForeignKeyRow>("PRAGMA foreign_key_list(system_command_receipts)")
    .toArray();
  const automationForeignKeys = sql
    .exec<ForeignKeyRow>("PRAGMA foreign_key_list(player_automation)")
    .toArray();
  if (
    !receiptForeignKeys.some(
      (foreignKey) =>
        foreignKey.from === "command_id" &&
        foreignKey.table === "deadlines" &&
        foreignKey.to === "deadline_id",
    ) ||
    !automationForeignKeys.some(
      (foreignKey) =>
        foreignKey.from === "actor_id" &&
        foreignKey.table === "members" &&
        foreignKey.to === "actor_id",
    )
  ) {
    throw new Error("TableRoom schema-v4 foreign keys are missing.");
  }
}

/**
 * Transactionally advances every supported TableRoom schema root to v4. This
 * path-isolated migration is invoked by TableRoom construction in Stage 5.
 */
export function migrateTableRoomStorageToV4(
  storage: DurableObjectStorage,
): void {
  storage.sql.exec("PRAGMA foreign_keys = ON");
  const foreignKeysEnabled = storage.sql
    .exec<{ [key: string]: SqlStorageValue; foreign_keys: number }>(
      "PRAGMA foreign_keys",
    )
    .one().foreign_keys;
  if (foreignKeysEnabled !== 1) {
    throw new Error("TableRoom SQLite foreign-key enforcement is unavailable.");
  }
  storage.transactionSync(() => {
    const sql = storage.sql;
    const metadata = sql
      .exec<SchemaVersionRow>(
        "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
      )
      .one();
    if (
      !Number.isSafeInteger(metadata.schema_version) ||
      metadata.schema_version < 1 ||
      metadata.schema_version > V4_SCHEMA_VERSION
    ) {
      throw new Error("Unsupported TableRoom storage schema version.");
    }
    requireExistingAuthorityTables(sql);
    let version = metadata.schema_version;
    if (version === 1) {
      sql.exec(
        "CREATE TABLE lobby_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_version INTEGER NOT NULL CHECK (state_version >= 0))",
      );
      sql.exec(
        "INSERT INTO lobby_state (singleton, state_version) VALUES (1, 0)",
      );
      sql.exec(
        "CREATE TABLE lobby_seats (seat TEXT PRIMARY KEY CHECK (seat IN ('east', 'south', 'west', 'north')), actor_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, ready INTEGER NOT NULL CHECK (ready IN (0, 1)))",
      );
      sql.exec(
        "CREATE TABLE lobby_command_receipts (command_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL)",
      );
      sql.exec(
        "UPDATE storage_metadata SET schema_version = 2 WHERE singleton = 1",
      );
      version = 2;
    }
    requireLobbyTables(sql);
    if (version === 2) {
      sql.exec(
        "CREATE TABLE canonical_game_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL, last_event_hash TEXT NOT NULL)",
      );
      sql.exec(
        "CREATE TABLE game_events (sequence INTEGER PRIMARY KEY CHECK (sequence >= 1), event_json TEXT NOT NULL, previous_hash TEXT, event_hash TEXT NOT NULL UNIQUE)",
      );
      sql.exec(
        "UPDATE storage_metadata SET schema_version = 3 WHERE singleton = 1",
      );
      version = 3;
    }
    requireGameTables(sql);
    if (version === 3) {
      sql.exec(
        "CREATE TABLE deadlines (deadline_id TEXT PRIMARY KEY CHECK (length(deadline_id) BETWEEN 1 AND 96), kind TEXT NOT NULL CHECK (kind IN ('reaction', 'turn', 'disconnect', 'abandonment')), due_at INTEGER NOT NULL CHECK (due_at BETWEEN 0 AND 9007199254740991), target_generation INTEGER NOT NULL CHECK (target_generation BETWEEN 0 AND 9007199254740991), payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 4096), status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'cancelled')), processed_at INTEGER CHECK (processed_at IS NULL OR processed_at BETWEEN 0 AND 9007199254740991))",
      );
      sql.exec(
        "CREATE INDEX deadlines_pending_due ON deadlines (due_at, deadline_id) WHERE status = 'pending'",
      );
      sql.exec(
        "CREATE TABLE system_command_receipts (command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 1 AND 96), request_json TEXT NOT NULL CHECK (length(request_json) BETWEEN 2 AND 4096), result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 2 AND 1024), processed_at INTEGER NOT NULL CHECK (processed_at BETWEEN 0 AND 9007199254740991), FOREIGN KEY (command_id) REFERENCES deadlines(deadline_id) ON DELETE RESTRICT)",
      );
      sql.exec(
        "CREATE TABLE room_lifecycle (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), room_activity_generation INTEGER NOT NULL CHECK (room_activity_generation BETWEEN 0 AND 9007199254740991), abandoned INTEGER NOT NULL CHECK (abandoned IN (0, 1)), updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991))",
      );
      sql.exec(
        "INSERT INTO room_lifecycle (singleton, room_activity_generation, abandoned, updated_at) VALUES (1, 0, 0, 0)",
      );
      sql.exec(
        "CREATE TABLE player_automation (actor_id TEXT PRIMARY KEY CHECK (length(actor_id) BETWEEN 1 AND 96), connection_generation INTEGER NOT NULL CHECK (connection_generation BETWEEN 0 AND 9007199254740991), autopilot INTEGER NOT NULL CHECK (autopilot IN (0, 1)), updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991), FOREIGN KEY (actor_id) REFERENCES members(actor_id) ON DELETE CASCADE)",
      );
      sql.exec(
        "UPDATE storage_metadata SET schema_version = 4 WHERE singleton = 1",
      );
    }
    requireV4Tables(sql);
    if (sql.exec("PRAGMA foreign_key_check").toArray().length !== 0) {
      throw new Error("TableRoom storage violates schema-v4 foreign keys.");
    }
  });
}
