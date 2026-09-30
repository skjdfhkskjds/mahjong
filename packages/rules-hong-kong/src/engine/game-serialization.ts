import { canonicalJson } from "./game-codec.js";
import type { HongKongGameEventV1 } from "./game-contracts.js";
import { assertGameEvent, assertGameInvariants } from "./game-invariants.js";
import type { CanonicalGameStateV1 } from "./game-state.js";

export function canonicalGameJson(state: CanonicalGameStateV1): string {
  assertGameInvariants(state);
  if (state.phase === "pending-win-validation") {
    throw new Error("Implementation-only win validation is not deployable.");
  }
  return canonicalJson(state);
}

export function decodeCanonicalGameJson(value: string): CanonicalGameStateV1 {
  const parsed = JSON.parse(value) as unknown;
  assertGameInvariants(parsed);
  if (canonicalGameJson(parsed) !== value) {
    throw new Error("Canonical game state bytes are not canonical.");
  }
  return parsed;
}

export function canonicalGameEventJson(event: HongKongGameEventV1): string {
  assertGameEvent(event);
  return canonicalJson(event);
}

export function decodeCanonicalGameEventJson(
  value: string,
): HongKongGameEventV1 {
  const parsed = JSON.parse(value) as unknown;
  assertGameEvent(parsed);
  if (canonicalGameEventJson(parsed) !== value) {
    throw new Error("Canonical game event bytes are not canonical.");
  }
  return parsed;
}

export function canonicalEventHashPayload(
  previousHash: string | null,
  event: HongKongGameEventV1,
): string {
  assertGameEvent(event);
  if (previousHash !== null && !/^[0-9a-f]{64}$/u.test(previousHash)) {
    throw new TypeError(
      "Previous event hash must be null or lowercase SHA-256.",
    );
  }
  return canonicalJson({ event, previousHash, version: 1 });
}
