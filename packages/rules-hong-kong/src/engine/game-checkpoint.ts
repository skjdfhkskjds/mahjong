import type { VersionedHongKongGameEvent } from "./game-contracts.js";
import { replayVersionedGameEvents } from "./game-reducer.js";
import { canonicalVersionedGameJson } from "./game-serialization.js";
import type { VersionedCanonicalGameState } from "./game-state.js";

/**
 * Proves that a decoded checkpoint is the deterministic result of the supplied
 * event history. State codecs establish internal coherence only; callers must
 * separately authenticate the event chain before treating this comparison as
 * a persisted-history authenticity check.
 */
export function assertVersionedCheckpointMatchesReplay(
  events: readonly VersionedHongKongGameEvent[],
  checkpoint: VersionedCanonicalGameState,
): void {
  const replayed = replayVersionedGameEvents(events);
  if (
    canonicalVersionedGameJson(replayed) !==
    canonicalVersionedGameJson(checkpoint)
  ) {
    throw new Error("Canonical game checkpoint diverges from event replay.");
  }
}
