import { seat } from "@mahjong/game-core";

import type {
  HongKongGameEvent,
  LegacyUpgradeProvenance,
  StateUpgradedEvent,
} from "./game-contracts.js";
import { reduceVersionedGameEvent, replayGameEvents } from "./game-reducer.js";
import {
  isCanonicalGameStateV2,
  type CanonicalGameStateV2,
} from "./game-state.js";

export function createStateUpgradeEvent(
  events: readonly [HongKongGameEvent, ...HongKongGameEvent[]],
): StateUpgradedEvent {
  const state = replayGameEvents(events);
  const tail = events.at(-1);
  if (tail === undefined) throw new Error("Legacy history requires genesis.");
  const eastHasDiscarded = events.some(
    (event) =>
      event.type === "game/tile-discarded" && event.seat === seat("east"),
  );
  let provenance: LegacyUpgradeProvenance;
  switch (tail.type) {
    case "game/started":
      provenance = {
        eastHasDiscarded,
        sourceSequence: 1,
        type: "initial-deal",
      };
      break;
    case "game/tile-discarded":
      provenance = {
        eastHasDiscarded,
        seat: tail.seat,
        sourceSequence: tail.sequence,
        tileId: tail.tileId,
        type: "discard",
      };
      break;
    case "game/turn-drawn":
      provenance = {
        eastHasDiscarded,
        exhausted: tail.exhausted,
        ordinaryTileId: tail.ordinaryTileId,
        replacementTileIds: tail.replacementTileIds,
        seat: tail.seat,
        sourceSequence: tail.sequence,
        type: "draw",
      };
      break;
    case "game/wall-exhausted":
      provenance = {
        eastHasDiscarded,
        requiredDraw: tail.requiredDraw,
        seat: tail.seat,
        sourceSequence: tail.sequence,
        type: "wall-exhausted",
      };
      break;
  }
  return {
    fromSchemaVersion: 1,
    provenance,
    sequence: state.sequence + 1,
    toSchemaVersion: 2,
    type: "game/state-upgraded",
  };
}

export function upgradeCanonicalGameState(
  events: readonly [HongKongGameEvent, ...HongKongGameEvent[]],
): {
  readonly event: StateUpgradedEvent;
  readonly state: CanonicalGameStateV2;
} {
  const legacy = replayGameEvents(events);
  const event = createStateUpgradeEvent(events);
  const state = reduceVersionedGameEvent(legacy, event);
  if (!isCanonicalGameStateV2(state)) {
    throw new Error("A state upgrade did not produce schema v2.");
  }
  return { event, state };
}
