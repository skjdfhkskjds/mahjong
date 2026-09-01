import { canonicalJson } from "./game-codec.js";
import type {
  HongKongGameEvent,
  VersionedHongKongGameEvent,
} from "./game-contracts.js";
import {
  assertGameInvariants,
  assertLegacyGameEvent,
  assertVersionedGameEvent,
} from "./game-invariants-migration.js";
import type {
  CanonicalGameState,
  VersionedCanonicalGameState,
} from "./game-state.js";

export function canonicalGameJson(state: CanonicalGameState): string {
  assertGameInvariants(state);
  return canonicalJson(state);
}

export function decodeCanonicalGameJson(value: string): CanonicalGameState {
  const parsed = JSON.parse(value) as unknown;
  assertGameInvariants(parsed);
  if (parsed.schemaVersion !== 1) {
    throw new Error("Legacy canonical game state must use schema version one.");
  }
  if (canonicalGameJson(parsed) !== value) {
    throw new Error("Canonical game state bytes are not canonical.");
  }
  return parsed;
}

export function canonicalVersionedGameJson(
  state: VersionedCanonicalGameState,
): string {
  assertGameInvariants(state);
  return canonicalJson(state);
}

export function decodeCanonicalVersionedGameJson(
  value: string,
): VersionedCanonicalGameState {
  const parsed = JSON.parse(value) as unknown;
  assertGameInvariants(parsed);
  if (canonicalVersionedGameJson(parsed) !== value) {
    throw new Error("Canonical versioned game state bytes are not canonical.");
  }
  return parsed;
}

export function canonicalGameEventJson(event: HongKongGameEvent): string {
  assertLegacyGameEvent(event);
  return canonicalJson(event);
}

export function decodeCanonicalGameEventJson(value: string): HongKongGameEvent {
  const parsed = JSON.parse(value) as unknown;
  assertLegacyGameEvent(parsed);
  if (canonicalGameEventJson(parsed) !== value) {
    throw new Error("Canonical game event bytes are not canonical.");
  }
  return parsed;
}

export function canonicalEventHashPayload(
  previousHash: string | null,
  event: HongKongGameEvent,
): string {
  assertLegacyGameEvent(event);
  if (previousHash !== null && !/^[0-9a-f]{64}$/u.test(previousHash)) {
    throw new TypeError(
      "Previous event hash must be null or lowercase SHA-256.",
    );
  }
  return canonicalJson({ event, previousHash, version: 1 });
}

export function canonicalVersionedGameEventJson(
  event: VersionedHongKongGameEvent,
): string {
  assertVersionedGameEvent(event);
  return canonicalJson(event);
}

export function decodeCanonicalVersionedGameEventJson(
  value: string,
): VersionedHongKongGameEvent {
  const parsed = JSON.parse(value) as unknown;
  assertVersionedGameEvent(parsed);
  if (canonicalVersionedGameEventJson(parsed) !== value) {
    throw new Error("Canonical versioned game event bytes are not canonical.");
  }
  return parsed;
}

export function canonicalVersionedEventHashPayload(
  previousHash: string | null,
  event: VersionedHongKongGameEvent,
): string {
  assertVersionedGameEvent(event);
  if (previousHash !== null && !/^[0-9a-f]{64}$/u.test(previousHash)) {
    throw new TypeError(
      "Previous event hash must be null or lowercase SHA-256.",
    );
  }
  return canonicalJson({ event, previousHash, version: 1 });
}
