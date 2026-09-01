import {
  nextSeat,
  seat,
  seats,
  type Seat,
  type TileId,
} from "@mahjong/game-core";

import { normalizeReactionWindow } from "../claims/reaction-resolution.js";
import { isLegalReaction } from "../claims/legal-reactions.js";
import {
  concealedKongMeld,
  legalAddedKongs,
  legalConcealedKongs,
  replacementFromTail,
} from "../kongs/kong-transitions.js";
import { canonicalTileIds, type DeclaredMeld } from "../melds/meld.js";
import { isBonusTile } from "../tiles/tile-kind-identity.js";
import { canonicalJson } from "./game-codec.js";
import type {
  AddedKongProposedEvent,
  ConcealedKongDeclaredEvent,
  DiscardReactionOpenedEvent,
  DrawnEvent,
  HongKongGameEvent,
  KongReplacementDrawnEvent,
  ReactionIntentSubmittedEvent,
  ReactionResolvedEvent,
  StateUpgradedEvent,
  VersionedHongKongGameEvent,
} from "./game-contracts.js";
import {
  assertGameInvariants,
  assertUpgradeProvenance,
  assertVersionedGameEvent,
  provenanceAcquisition,
  provenanceTileId,
} from "./game-invariants-migration.js";
import {
  playerAt,
  type AddedKongReactionWindow,
  type VersionedCanonicalGameState,
  type CanonicalGameStateV1,
  type CanonicalGameStateV2,
  type CanonicalPlayerStateV1,
  type CanonicalPlayerStateV2,
  type SeatMap,
} from "./game-state.js";

export function reduceVersionedGameEvent(
  state: VersionedCanonicalGameState | undefined,
  event: VersionedHongKongGameEvent,
): VersionedCanonicalGameState {
  assertVersionedGameEvent(event);
  if (event.type === "game/started") {
    if (state !== undefined || event.state.sequence !== 1) {
      throw new Error("Invalid game genesis event.");
    }
    assertGameInvariants(event.state);
    return event.state;
  }
  if (state === undefined || event.sequence !== state.sequence + 1) {
    throw new Error("Non-contiguous game event sequence.");
  }
  if (event.type === "game/state-upgraded") {
    if (state.schemaVersion !== 1)
      throw new Error("Only schema v1 can upgrade.");
    const next = upgradeState(state, event);
    assertGameInvariants(next);
    return next;
  }
  const next =
    state.schemaVersion === 1
      ? reduceLegacyEvent(state, event)
      : reduceV2Event(state, event);
  assertGameInvariants(next);
  return next;
}

function reduceLegacyEvent(
  state: CanonicalGameStateV1,
  event: VersionedHongKongGameEvent,
): CanonicalGameStateV1 {
  if (event.type === "game/wall-exhausted") {
    if (
      state.phase !== "awaiting-draw" ||
      event.seat !== state.turn ||
      state.wall.head <= state.wall.tail
    ) {
      throw new Error(
        "Exhaustion event is not required by the canonical wall.",
      );
    }
    return { ...state, phase: "exhausted", sequence: event.sequence };
  }
  if (event.type === "game/tile-discarded") {
    if (
      (state.phase !== "awaiting-dealer-discard" &&
        state.phase !== "awaiting-discard") ||
      event.seat !== state.turn
    ) {
      throw new Error("Discard event has the wrong seat.");
    }
    const player = playerAt(state.players, event.seat);
    const hand = removeExactTiles(player.hand, [event.tileId]);
    return {
      ...state,
      phase: "awaiting-draw",
      players: replacePlayerV1(state.players, event.seat, {
        ...player,
        discards: [...player.discards, event.tileId],
        hand,
      }),
      sequence: event.sequence,
      turn: nextSeat(event.seat),
    };
  }
  if (event.type === "game/turn-drawn") {
    return reduceDraw(state, event) as CanonicalGameStateV1;
  }
  throw new Error("A schema-v2 event cannot reduce schema-v1 state.");
}

function reduceV2Event(
  state: CanonicalGameStateV2,
  event: VersionedHongKongGameEvent,
): CanonicalGameStateV2 {
  switch (event.type) {
    case "game/wall-exhausted": {
      if (
        state.phase !== "awaiting-draw" ||
        event.seat !== state.turn ||
        state.wall.head <= state.wall.tail
      ) {
        throw new Error(
          "Exhaustion event is not required by the canonical wall.",
        );
      }
      return { ...state, phase: "exhausted", sequence: event.sequence };
    }
    case "game/turn-drawn":
      return reduceDraw(state, event) as CanonicalGameStateV2;
    case "game/discard-reaction-opened":
      return reduceDiscardReactionOpened(state, event);
    case "game/reaction-intent-submitted":
      return reduceReactionIntent(state, event);
    case "game/reaction-resolved":
      return reduceReactionResolved(state, event);
    case "game/concealed-kong-declared":
      return reduceConcealedKong(state, event);
    case "game/added-kong-proposed":
      return reduceAddedKongProposal(state, event);
    case "game/kong-replacement-drawn":
      return reduceKongReplacement(state, event);
    case "game/tile-discarded":
      throw new Error(
        "Legacy discard events cannot reinterpret schema-v2 state.",
      );
    case "game/state-upgraded":
    case "game/started":
      throw new Error("Unexpected game lifecycle event.");
  }
}

function reduceDraw(
  state: VersionedCanonicalGameState,
  event: DrawnEvent,
): VersionedCanonicalGameState {
  if (
    state.phase !== "awaiting-draw" ||
    event.seat !== state.turn ||
    event.ordinaryTileId !== state.wall.order[state.wall.head]
  ) {
    throw new Error("Draw event does not match the canonical wall.");
  }
  let tail = state.wall.tail;
  let replacementRequired = isBonusTile(event.ordinaryTileId);
  for (const replacement of event.replacementTileIds) {
    if (!replacementRequired) {
      throw new Error("Replacement chain continues after a structural tile.");
    }
    if (replacement !== state.wall.order[tail]) {
      throw new Error("Replacement draw does not match the wall tail.");
    }
    tail -= 1;
    replacementRequired = isBonusTile(replacement);
  }
  if (
    replacementRequired !== event.exhausted ||
    (replacementRequired && tail >= state.wall.head + 1)
  ) {
    throw new Error("Draw event does not contain the exact replacement chain.");
  }
  const drawn = [event.ordinaryTileId, ...event.replacementTileIds];
  const bonuses = drawn.filter(isBonusTile);
  const structural = drawn.filter((id) => !isBonusTile(id));
  if (
    (!event.exhausted && structural.length !== 1) ||
    (event.exhausted && structural.length !== 0)
  ) {
    throw new Error("Draw event has an invalid replacement outcome.");
  }
  if (state.schemaVersion === 1) {
    const player = playerAt(state.players, event.seat);
    return {
      ...state,
      phase: event.exhausted ? "exhausted" : "awaiting-discard",
      players: replacePlayerV1(state.players, event.seat, {
        ...player,
        bonuses: [...player.bonuses, ...bonuses],
        hand: [...player.hand, ...structural],
      }),
      sequence: event.sequence,
      wall: { ...state.wall, head: state.wall.head + 1, tail },
    };
  }
  const player = playerAt(state.players, event.seat);
  return {
    ...state,
    phase: event.exhausted ? "exhausted" : "awaiting-discard",
    players: replacePlayerV2(state.players, event.seat, {
      ...player,
      bonuses: [...player.bonuses, ...bonuses],
      hand: [...player.hand, ...structural],
    }),
    sequence: event.sequence,
    turnProvenance: {
      ...state.turnProvenance,
      lastAcquiredTileId: structural[0] ?? null,
      lastAcquisition: event.exhausted
        ? null
        : event.replacementTileIds.length > 0
          ? "replacement"
          : "draw",
      replacementChainDepth: 0,
      replacementPending: false,
    },
    wall: { ...state.wall, head: state.wall.head + 1, tail },
  };
}

function reduceDiscardReactionOpened(
  state: CanonicalGameStateV2,
  event: DiscardReactionOpenedEvent,
): CanonicalGameStateV2 {
  if (
    (state.phase !== "awaiting-dealer-discard" &&
      state.phase !== "awaiting-discard") ||
    state.turnProvenance.replacementPending ||
    state.reactionWindow !== null ||
    event.seat !== state.turn ||
    event.windowId !== `discard:${String(event.sequence)}`
  ) {
    throw new Error("Discard reaction event has invalid phase or identity.");
  }
  const player = playerAt(state.players, event.seat);
  const hand = removeExactTiles(player.hand, [event.tileId]);
  const responderOrder = threeSeatsAfter(event.seat);
  return {
    ...state,
    phase: "awaiting-discard-reactions",
    players: replacePlayerV2(state.players, event.seat, {
      ...player,
      discards: [...player.discards, event.tileId],
      hand,
    }),
    reactionWindow: {
      id: event.windowId,
      intents: {},
      kind: "discard",
      openingSequence: event.sequence,
      responderOrder,
      sourceSeat: event.seat,
      sourceTileId: event.tileId,
    },
    sequence: event.sequence,
    turn: nextSeat(event.seat),
    turnProvenance: {
      ...state.turnProvenance,
      eastHasDiscarded:
        state.turnProvenance.eastHasDiscarded || event.seat === seat("east"),
      lastAcquiredTileId: null,
      lastAcquisition: null,
      replacementChainDepth: 0,
      replacementPending: false,
    },
  };
}

function reduceReactionIntent(
  state: CanonicalGameStateV2,
  event: ReactionIntentSubmittedEvent,
): CanonicalGameStateV2 {
  const window = state.reactionWindow;
  if (
    (state.phase !== "awaiting-discard-reactions" &&
      state.phase !== "awaiting-added-kong-reactions") ||
    event.windowId !== window?.id ||
    playerAt(state.players, event.seat).actorId !== event.actorId ||
    !window.responderOrder.includes(event.seat) ||
    Object.hasOwn(window.intents, event.actorId) ||
    !isLegalReaction(state, event.seat, event.response, {
      includeStructuralWin: true,
    })
  ) {
    throw new Error("Reaction intent is not valid for the open window.");
  }
  return {
    ...state,
    reactionWindow: {
      ...window,
      intents: {
        ...window.intents,
        [event.actorId]: { response: event.response, seat: event.seat },
      },
    },
    sequence: event.sequence,
  };
}

function reduceReactionResolved(
  state: CanonicalGameStateV2,
  event: ReactionResolvedEvent,
): CanonicalGameStateV2 {
  const window = state.reactionWindow;
  if (
    (state.phase !== "awaiting-discard-reactions" &&
      state.phase !== "awaiting-added-kong-reactions") ||
    window?.id !== event.windowId
  ) {
    throw new Error("Reaction resolution targets a closed window.");
  }
  const expected = normalizeReactionWindow(state, window);
  if (
    canonicalJson(expected.responses) !== canonicalJson(event.responses) ||
    canonicalJson(expected.outcome) !== canonicalJson(event.outcome)
  ) {
    throw new Error(
      "Reaction resolution is not the canonical normalized result.",
    );
  }
  if (event.outcome.type === "structural-win") {
    return {
      ...state,
      phase: "pending-win-validation",
      sequence: event.sequence,
    };
  }
  if (window.kind === "added-kong") {
    if (event.outcome.type !== "all-pass") {
      throw new Error("Only a scored win may interrupt an added kong.");
    }
    return commitAddedKong(state, window, event.sequence);
  }
  if (event.outcome.type === "all-pass") {
    return {
      ...state,
      phase: "awaiting-draw",
      reactionWindow: null,
      sequence: event.sequence,
      turn: nextSeat(window.sourceSeat),
    };
  }
  const claimant = playerAt(state.players, event.outcome.seat);
  const response = event.outcome.response;
  const source = playerAt(state.players, window.sourceSeat);
  const sourceDiscard = source.discards.at(-1);
  if (sourceDiscard !== window.sourceTileId) {
    throw new Error("Claimed discard is no longer the most recent discard.");
  }
  const hand = removeExactTiles(claimant.hand, response.handTileIds);
  const kind = response.type === "kong" ? "kong" : response.type;
  const meld: DeclaredMeld = {
    claimedTileId: window.sourceTileId,
    exposure: "exposed",
    id: `meld:${String(event.sequence)}`,
    kind,
    ...(response.type === "kong" ? { kongKind: "exposed" as const } : {}),
    sourceSeat: window.sourceSeat,
    tileIds: canonicalTileIds([...response.handTileIds, window.sourceTileId]),
  };
  let players = replacePlayerV2(state.players, window.sourceSeat, {
    ...source,
    discards: source.discards.slice(0, -1),
  });
  players = replacePlayerV2(players, event.outcome.seat, {
    ...claimant,
    hand,
    melds: [...claimant.melds, meld],
  });
  return {
    ...state,
    phase: "awaiting-discard",
    players,
    reactionWindow: null,
    sequence: event.sequence,
    turn: event.outcome.seat,
    turnProvenance: {
      ...state.turnProvenance,
      eastHasDeclaredKong:
        state.turnProvenance.eastHasDeclaredKong ||
        (response.type === "kong" && event.outcome.seat === seat("east")),
      lastAcquiredTileId: window.sourceTileId,
      lastAcquisition: null,
      replacementChainDepth: 0,
      replacementPending: response.type === "kong",
    },
  };
}

function reduceConcealedKong(
  state: CanonicalGameStateV2,
  event: ConcealedKongDeclaredEvent,
): CanonicalGameStateV2 {
  if (
    event.seat !== state.turn ||
    !legalConcealedKongs(state, event.seat).some(
      (candidate) => numericIds(candidate) === numericIds(event.meld.tileIds),
    ) ||
    canonicalJson(event.meld) !==
      canonicalJson(
        concealedKongMeld(
          event.sequence,
          event.meld.tileIds as readonly [TileId, TileId, TileId, TileId],
        ),
      )
  ) {
    throw new Error("Concealed kong event is not exactly legal.");
  }
  const player = playerAt(state.players, event.seat);
  return {
    ...state,
    players: replacePlayerV2(state.players, event.seat, {
      ...player,
      hand: removeExactTiles(player.hand, event.meld.tileIds),
      melds: [...player.melds, event.meld],
    }),
    sequence: event.sequence,
    turnProvenance: {
      ...state.turnProvenance,
      eastHasDeclaredKong:
        state.turnProvenance.eastHasDeclaredKong || event.seat === seat("east"),
      replacementPending: true,
    },
  };
}

function reduceAddedKongProposal(
  state: CanonicalGameStateV2,
  event: AddedKongProposedEvent,
): CanonicalGameStateV2 {
  if (
    !legalAddedKongs(state, event.seat).some(
      (candidate) =>
        candidate.meldId === event.meldId && candidate.tileId === event.tileId,
    ) ||
    event.windowId !== `added-kong:${String(event.sequence)}`
  ) {
    throw new Error("Added kong proposal is not exactly legal.");
  }
  return {
    ...state,
    phase: "awaiting-added-kong-reactions",
    reactionWindow: {
      id: event.windowId,
      intents: {},
      kind: "added-kong",
      openingSequence: event.sequence,
      responderOrder: threeSeatsAfter(event.seat),
      sourceMeldId: event.meldId,
      sourceSeat: event.seat,
      sourceTileId: event.tileId,
    },
    sequence: event.sequence,
  };
}

function commitAddedKong(
  state: CanonicalGameStateV2,
  window: AddedKongReactionWindow,
  sequence: number,
): CanonicalGameStateV2 {
  const player = playerAt(state.players, window.sourceSeat);
  const meldIndex = player.melds.findIndex(
    (meld) => meld.id === window.sourceMeldId,
  );
  const meld = player.melds[meldIndex];
  if (meld?.kind !== "pung" || !player.hand.includes(window.sourceTileId)) {
    throw new Error("Added kong source pung or tile disappeared.");
  }
  const added: DeclaredMeld = {
    ...meld,
    kind: "kong",
    kongKind: "added",
    tileIds: canonicalTileIds([...meld.tileIds, window.sourceTileId]),
  };
  return {
    ...state,
    phase: "awaiting-discard",
    players: replacePlayerV2(state.players, window.sourceSeat, {
      ...player,
      hand: removeExactTiles(player.hand, [window.sourceTileId]),
      melds: player.melds.map((candidate, index) =>
        index === meldIndex ? added : candidate,
      ),
    }),
    reactionWindow: null,
    sequence,
    turn: window.sourceSeat,
    turnProvenance: {
      ...state.turnProvenance,
      eastHasDeclaredKong:
        state.turnProvenance.eastHasDeclaredKong ||
        window.sourceSeat === seat("east"),
      replacementPending: true,
    },
  };
}

function reduceKongReplacement(
  state: CanonicalGameStateV2,
  event: KongReplacementDrawnEvent,
): CanonicalGameStateV2 {
  if (
    (state.phase !== "awaiting-dealer-discard" &&
      state.phase !== "awaiting-discard") ||
    !state.turnProvenance.replacementPending ||
    event.seat !== state.turn
  ) {
    throw new Error("Kong replacement is not required in this state.");
  }
  const expected = replacementFromTail(state);
  if (
    event.exhausted !== expected.exhausted ||
    numericIds(event.tileIds) !== numericIds(expected.tileIds)
  ) {
    throw new Error("Kong replacement does not match the exact wall tail.");
  }
  const bonuses = event.tileIds.filter(isBonusTile);
  const structural = event.tileIds.filter((id) => !isBonusTile(id));
  const player = playerAt(state.players, event.seat);
  return {
    ...state,
    phase: event.exhausted ? "exhausted" : state.phase,
    players: replacePlayerV2(state.players, event.seat, {
      ...player,
      bonuses: [...player.bonuses, ...bonuses],
      hand: [...player.hand, ...structural],
    }),
    sequence: event.sequence,
    turnProvenance: {
      ...state.turnProvenance,
      lastAcquiredTileId: structural[0] ?? null,
      lastAcquisition: event.exhausted ? null : "replacement",
      replacementChainDepth: state.turnProvenance.replacementChainDepth + 1,
      replacementPending: false,
    },
    wall: { ...state.wall, tail: state.wall.tail - event.tileIds.length },
  };
}

function upgradeState(
  state: CanonicalGameStateV1,
  event: StateUpgradedEvent,
): CanonicalGameStateV2 {
  assertUpgradeProvenance(state, event.provenance);
  const players = Object.fromEntries(
    seats.map((currentSeat) => [
      currentSeat,
      { ...playerAt(state.players, currentSeat), melds: [] },
    ]),
  ) as unknown as SeatMap<CanonicalPlayerStateV2>;
  return {
    ...state,
    players,
    prevailingWind: "east",
    reactionWindow: null,
    result: null,
    schemaVersion: 2,
    sequence: event.sequence,
    turnProvenance: {
      eastHasDeclaredKong: false,
      eastHasDiscarded: event.provenance.eastHasDiscarded,
      lastAcquiredTileId: provenanceTileId(state, event.provenance),
      lastAcquisition: provenanceAcquisition(state, event.provenance),
      replacementChainDepth: 0,
      replacementPending: false,
    },
  };
}

export function replayGameEvents(
  events: readonly HongKongGameEvent[],
): CanonicalGameStateV1 {
  let state: CanonicalGameStateV1 | undefined;
  for (const event of events) state = reduceGameEvent(state, event);
  if (state === undefined)
    throw new Error("A game event stream must contain genesis.");
  return state;
}

export function reduceGameEvent(
  state: CanonicalGameStateV1 | undefined,
  event: HongKongGameEvent,
): CanonicalGameStateV1 {
  const next = reduceVersionedGameEvent(state, event);
  if (next.schemaVersion !== 1) {
    throw new Error("Legacy event reduction cannot produce schema v2.");
  }
  return next;
}

export function replayVersionedGameEvents(
  events: readonly VersionedHongKongGameEvent[],
): VersionedCanonicalGameState {
  let state: VersionedCanonicalGameState | undefined;
  for (const event of events) state = reduceVersionedGameEvent(state, event);
  if (state === undefined)
    throw new Error("A game event stream must contain genesis.");
  return state;
}

function replacePlayerV1(
  players: SeatMap<CanonicalPlayerStateV1>,
  currentSeat: Seat,
  player: CanonicalPlayerStateV1,
): SeatMap<CanonicalPlayerStateV1> {
  return { ...players, [currentSeat]: player };
}

function replacePlayerV2(
  players: SeatMap<CanonicalPlayerStateV2>,
  currentSeat: Seat,
  player: CanonicalPlayerStateV2,
): SeatMap<CanonicalPlayerStateV2> {
  return { ...players, [currentSeat]: player };
}

function removeExactTiles(
  hand: readonly TileId[],
  tileIds: readonly TileId[],
): readonly TileId[] {
  const removed = new Set(tileIds);
  if (
    removed.size !== tileIds.length ||
    tileIds.some((id) => !hand.includes(id))
  ) {
    throw new Error("Event references a physical tile outside the hand.");
  }
  return hand.filter((id) => !removed.has(id));
}

function threeSeatsAfter(source: Seat): readonly [Seat, Seat, Seat] {
  const first = nextSeat(source);
  const second = nextSeat(first);
  return [first, second, nextSeat(second)];
}

function numericIds(tileIds: readonly TileId[]): string {
  return tileIds.map(Number).join(",");
}
