import {
  canonicalEventHashPayload,
  canonicalGameEventJson,
  canonicalGameJson,
  reduceGameEvent,
  type NonEmptyGameEventBatch,
  type CanonicalGameStateV1,
  type HongKongGameEventV1,
} from "@mahjong/rules-hong-kong";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export interface PreparedGameEventRow {
  readonly eventHash: string;
  readonly eventJson: string;
  readonly previousHash: string | null;
  readonly sequence: number;
}

export interface PreparedGameEventBatch {
  readonly finalState: CanonicalGameStateV1;
  readonly finalStateJson: string;
  readonly lastEventHash: string;
  readonly rows: readonly [PreparedGameEventRow, ...PreparedGameEventRow[]];
}

export interface VerifiedStoredGame {
  readonly events: readonly [HongKongGameEventV1, ...HongKongGameEventV1[]];
  readonly lastEventHash: string;
  readonly state: CanonicalGameStateV1;
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
    const next = reduceGameEvent(state, event);
    const eventJson = canonicalGameEventJson(event);
    const eventHash = await digest(
      canonicalEventHashPayload(previousHash, event),
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
    finalStateJson: canonicalGameJson(state),
    lastEventHash: previousHash,
    rows: [first, ...rows.slice(1)],
  };
}
