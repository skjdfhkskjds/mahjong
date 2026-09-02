import {
  applyGameCommandV2,
  reduceVersionedGameEvent,
  type CanonicalGameStateV2,
  type NonEmptyGameEventBatch,
  type VersionedHongKongGameEvent,
} from "@mahjong/rules-hong-kong";

import type { TableSeat } from "./table-room-protocol.js";

export function gamePlayerAt(
  state: CanonicalGameStateV2,
  seat: TableSeat | CanonicalGameStateV2["turn"],
) {
  switch (seat) {
    case "east":
      return state.players.east;
    case "south":
      return state.players.south;
    case "west":
      return state.players.west;
    case "north":
      return state.players.north;
  }
  throw new Error("Canonical game contains an unsupported seat.");
}

function automaticDiscardTile(state: CanonicalGameStateV2) {
  const player = gamePlayerAt(state, state.turn);
  const acquired = state.turnProvenance.lastAcquiredTileId;
  if (acquired !== null && player.hand.includes(acquired)) return acquired;
  const first = [...player.hand].sort((left, right) => left - right)[0];
  if (first === undefined) {
    throw new Error("An automatic discard requires a concealed tile.");
  }
  return first;
}

/**
 * Selects only the frozen deterministic timeout policy. Automation may pass,
 * draw, replace bonuses, and discard; it never selects a win or kong action.
 */
export function automaticGameEvents(
  state: CanonicalGameStateV2,
  actorId: string,
): NonEmptyGameEventBatch | undefined {
  if (state.reactionWindow !== null) {
    const player = (["east", "south", "west", "north"] as const)
      .map((seat) => gamePlayerAt(state, seat))
      .find((candidate) => candidate.actorId === actorId);
    if (
      player === undefined ||
      !state.reactionWindow.responderOrder.includes(player.seat) ||
      Object.hasOwn(state.reactionWindow.intents, actorId)
    ) {
      return undefined;
    }
    const pass = applyGameCommandV2(state, actorId, {
      type: "game/react",
      response: { type: "pass" },
      windowId: state.reactionWindow.id,
    });
    return pass.accepted ? pass.events : undefined;
  }
  if (gamePlayerAt(state, state.turn).actorId !== actorId) return undefined;
  if (state.phase === "awaiting-draw") {
    const drawn = applyGameCommandV2(state, actorId, { type: "game/draw" });
    if (!drawn.accepted) return undefined;
    let afterDraw = state;
    for (const event of drawn.events) {
      const reduced = reduceVersionedGameEvent(afterDraw, event);
      if (reduced.schemaVersion !== 2) {
        throw new Error("Automatic draw produced legacy state.");
      }
      afterDraw = reduced;
    }
    if (afterDraw.phase !== "awaiting-discard") return drawn.events;
    const discarded = applyGameCommandV2(afterDraw, actorId, {
      type: "game/discard",
      tileId: automaticDiscardTile(afterDraw),
    });
    if (!discarded.accepted) return drawn.events;
    return [drawn.events[0], ...drawn.events.slice(1), ...discarded.events];
  }
  if (
    state.phase === "awaiting-dealer-discard" ||
    state.phase === "awaiting-discard"
  ) {
    const discarded = applyGameCommandV2(state, actorId, {
      type: "game/discard",
      tileId: automaticDiscardTile(state),
    });
    return discarded.accepted ? discarded.events : undefined;
  }
  return undefined;
}

/** Appends deterministic passes for every currently automated responder. */
export function automaticReactionPassEvents(
  state: CanonicalGameStateV2,
  automatedActorIds: ReadonlySet<string>,
): NonEmptyGameEventBatch | undefined {
  let current = state;
  const events: VersionedHongKongGameEvent[] = [];
  while (current.reactionWindow !== null) {
    const responder = current.reactionWindow.responderOrder
      .map((seat) => gamePlayerAt(current, seat).actorId)
      .find(
        (actorId) =>
          automatedActorIds.has(actorId) &&
          !Object.hasOwn(current.reactionWindow?.intents ?? {}, actorId),
      );
    if (responder === undefined) break;
    const pass = applyGameCommandV2(current, responder, {
      type: "game/react",
      response: { type: "pass" },
      windowId: current.reactionWindow.id,
    });
    if (!pass.accepted || pass.state === undefined) {
      throw new Error("Automatic reaction pass was rejected.");
    }
    events.push(...pass.events);
    current = pass.state;
  }
  const first = events[0];
  return first === undefined ? undefined : [first, ...events.slice(1)];
}
