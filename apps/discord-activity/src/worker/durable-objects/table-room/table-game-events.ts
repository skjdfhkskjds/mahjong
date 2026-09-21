import {
  canonicalVersionedEventHashPayload,
  canonicalVersionedGameEventJson,
  canonicalVersionedGameJson,
  decodeCanonicalGameEventJson,
  reduceVersionedGameEvent,
  upgradeCanonicalGameState,
  type HongKongGameEvent,
  type NonEmptyGameEventBatch,
  type VersionedCanonicalGameState,
  type VersionedHongKongGameEvent,
} from "@mahjong/rules-hong-kong";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export interface PreparedGameEventRow {
  readonly eventHash: string;
  readonly eventJson: string;
  readonly previousHash: string | null;
  readonly sequence: number;
}

export interface PreparedGameEventBatch {
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

export async function digestGameEventPayload(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function assertGameEventDigest(value: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error("The game event digest is not lowercase SHA-256.");
  }
}

/** Prepares hashes and the reduced checkpoint before entering SQLite. */
export async function prepareGameEventBatch(
  prior: VerifiedStoredGame | undefined,
  events: NonEmptyGameEventBatch,
  digest: EventDigest = digestGameEventPayload,
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
    assertGameEventDigest(eventHash);
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
    finalState: state,
    finalStateJson: canonicalVersionedGameJson(state),
    lastEventHash: previousHash,
    rows: [first, ...rows.slice(1)],
  };
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
  digest: EventDigest = digestGameEventPayload,
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
