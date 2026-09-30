import type { HongKongGameEventV1 } from "./game-contracts.js";
import { replayGameEvents } from "./game-reducer.js";
import { canonicalGameJson } from "./game-serialization.js";
import type { CanonicalGameStateV1 } from "./game-state.js";

/**
 * Proves that a decoded checkpoint is the deterministic result of the supplied
 * event history. State codecs establish internal coherence only; callers must
 * separately authenticate the event chain before treating this comparison as
 * a persisted-history authenticity check.
 */
export function assertCheckpointMatchesReplay(
  events: readonly HongKongGameEventV1[],
  checkpoint: CanonicalGameStateV1,
): void {
  const replayed = replayGameEvents(events);
  if (canonicalGameJson(replayed) !== canonicalGameJson(checkpoint)) {
    throw new Error("Canonical game checkpoint diverges from event replay.");
  }
}
