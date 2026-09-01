import {
  nextSeat,
  seat,
  seats,
  type Seat,
  type TileId,
} from "@mahjong/game-core";

import { isLegalReaction } from "../claims/legal-reactions.js";
import { normalizeReactionWindow } from "../claims/reaction-resolution.js";
import { initialDealSeatOrder } from "../setup/initial-deal.js";
import { canonicalTileIds, type DeclaredMeld } from "../melds/meld.js";
import {
  isBonusTile,
  sameTileKind,
  tileKind,
} from "../tiles/tile-kind-identity.js";
import { HONG_KONG_V1_SHUFFLE_ALGORITHM } from "../wall/deterministic-shuffle.js";
import { canonicalJson, hasExactKeys, isRecord } from "./game-codec.js";
import type {
  HongKongGameEvent,
  LegacyUpgradeProvenance,
  VersionedHongKongGameEvent,
} from "./game-contracts.js";
import {
  playerAt,
  type VersionedCanonicalGameState,
  type CanonicalGameStateV1,
  type CanonicalGameStateV2,
  type CompletionProvenance,
  type ReactionResponse,
  type SubmittedReactionIntent,
} from "./game-state.js";
import {
  assertCompletedHandResult,
  assertResultMatchesCompletionProvenance,
  scoreReactionWinCandidate,
  scoreSelfWinCandidate,
} from "./win-resolution.js";

export function assertUpgradeProvenance(
  state: CanonicalGameStateV1,
  provenance: LegacyUpgradeProvenance,
): void {
  if (
    provenance.sourceSequence !== state.sequence ||
    (provenance.type === "initial-deal"
      ? provenance.eastHasDiscarded
      : !provenance.eastHasDiscarded)
  ) {
    throw new Error("State upgrade provenance does not match legacy state.");
  }
  if (provenance.type === "initial-deal") {
    if (state.sequence !== 1) {
      throw new Error("Initial-deal provenance requires legacy genesis.");
    }
    return;
  }
  if (provenance.type === "discard") {
    const source = playerAt(state.players, provenance.seat);
    if (
      state.phase !== "awaiting-draw" ||
      state.turn !== nextSeat(provenance.seat) ||
      source.discards.at(-1) !== provenance.tileId
    ) {
      throw new Error("Discard provenance is incoherent with legacy state.");
    }
    return;
  }
  if (provenance.type === "wall-exhausted") {
    if (
      state.phase !== "exhausted" ||
      state.turn !== provenance.seat ||
      state.wall.head <= state.wall.tail
    ) {
      throw new Error("Exhaustion provenance is incoherent with legacy state.");
    }
    return;
  }
  if (
    state.phase !== (provenance.exhausted ? "exhausted" : "awaiting-discard") ||
    state.turn !== provenance.seat ||
    state.wall.order[state.wall.head - 1] !== provenance.ordinaryTileId
  ) {
    throw new Error("Draw provenance is incoherent with legacy state.");
  }
  provenance.replacementTileIds.forEach((tileId, index) => {
    if (
      state.wall.order[
        state.wall.tail + provenance.replacementTileIds.length - index
      ] !== tileId
    ) {
      throw new Error("Replacement provenance is incoherent with legacy wall.");
    }
  });
  const structural = [
    provenance.ordinaryTileId,
    ...provenance.replacementTileIds,
  ].filter((tileId) => !isBonusTile(tileId));
  const acquired = structural.at(-1);
  if (
    !provenance.exhausted &&
    (acquired === undefined ||
      !playerAt(state.players, provenance.seat).hand.includes(acquired))
  ) {
    throw new Error("Draw provenance does not identify the acquired tile.");
  }
}

export function provenanceTileId(
  state: CanonicalGameStateV1,
  provenance: LegacyUpgradeProvenance,
): TileId | null {
  if (state.phase === "exhausted") return null;
  if (provenance.type === "initial-deal") {
    return initialEastAcquisition(state).tileId;
  }
  if (provenance.type !== "draw") return null;
  return (
    [provenance.ordinaryTileId, ...provenance.replacementTileIds]
      .filter((tileId) => !isBonusTile(tileId))
      .at(-1) ?? null
  );
}

export function provenanceAcquisition(
  state: CanonicalGameStateV1,
  provenance: LegacyUpgradeProvenance,
): "bonus-replacement" | "deal" | "draw" | "kong-replacement" | null {
  if (state.phase === "exhausted") return null;
  if (provenance.type === "initial-deal") {
    return initialEastAcquisition(state).acquisition;
  }
  if (provenance.type !== "draw") return null;
  return provenance.replacementTileIds.length > 0
    ? "bonus-replacement"
    : "draw";
}

function initialEastAcquisition(
  state: CanonicalGameStateV1 | CanonicalGameStateV2,
): {
  readonly acquisition: "bonus-replacement" | "deal";
  readonly tileId: TileId | null;
} {
  const eastDealt = initialDealSeatOrder.flatMap((assignedSeat, index) => {
    const id = state.wall.order[index];
    return assignedSeat === seat("east") && id !== undefined ? [id] : [];
  });
  let tail = state.wall.order.length - 1;
  let lastReplacement: TileId | null = null;
  for (const dealtId of eastDealt) {
    if (!isBonusTile(dealtId)) continue;
    let replacement = state.wall.order[tail];
    tail -= 1;
    while (replacement !== undefined && isBonusTile(replacement)) {
      replacement = state.wall.order[tail];
      tail -= 1;
    }
    if (replacement !== undefined) lastReplacement = replacement;
  }
  return lastReplacement === null
    ? { acquisition: "deal", tileId: state.players.east.hand.at(-1) ?? null }
    : { acquisition: "bonus-replacement", tileId: lastReplacement };
}

export function assertGameInvariants(
  value: unknown,
): asserts value is VersionedCanonicalGameState {
  if (!isRecord(value) || value["schemaVersion"] === 1) {
    assertV1State(value);
    return;
  }
  if (
    value["schemaVersion"] !== 2 ||
    !hasExactKeys(value, [
      "completionProvenance",
      "phase",
      "players",
      "prevailingWind",
      "reactionWindow",
      "result",
      "ruleset",
      "schemaVersion",
      "sequence",
      "shuffleAlgorithm",
      "turn",
      "turnProvenance",
      "wall",
    ]) ||
    value["ruleset"] !== "hong-kong/v1" ||
    value["shuffleAlgorithm"] !== HONG_KONG_V1_SHUFFLE_ALGORITHM ||
    value["prevailingWind"] !== "east" ||
    !(
      [
        "awaiting-dealer-discard",
        "awaiting-draw",
        "awaiting-discard",
        "awaiting-discard-reactions",
        "awaiting-added-kong-reactions",
        "pending-win-validation",
        "complete",
        "exhausted",
      ] as readonly string[]
    ).includes(value["phase"] as string)
  ) {
    throw new Error("Unsupported canonical game encoding.");
  }
  const state = value as unknown as CanonicalGameStateV2;
  if (state.phase === "complete") {
    assertCompletedHandResult(state.result);
    const completionProvenance = assertCompletionProvenance(state);
    assertResultMatchesCompletionProvenance(state.result, completionProvenance);
  } else if (state.result !== null || state.completionProvenance !== null) {
    throw new Error(
      "Only a complete hand may contain result or completion provenance.",
    );
  }
  assertCommonState(state);
  assertTurnProvenance(state);
  assertReactionWindow(state);
  const meldIds = new Set<string>();
  for (const currentSeat of seats) {
    const player = playerAt(state.players, currentSeat);
    if (
      !isRecord(player) ||
      !hasExactKeys(player, [
        "actorId",
        "bonuses",
        "discards",
        "hand",
        "melds",
        "seat",
      ]) ||
      !Array.isArray(player.melds)
    ) {
      throw new Error("Schema-v2 players require exact meld collections.");
    }
    for (const meld of player.melds) {
      assertMeld(meld);
      if (meldIds.has(meld.id)) throw new Error("Meld IDs must be unique.");
      meldIds.add(meld.id);
    }
  }
  if (state.phase === "complete" && state.result !== null) {
    const winner = playerAt(state.players, state.result.winnerSeat);
    const completedHand = {
      bonusTileIds: [...winner.bonuses].sort(numericTileOrder),
      concealedTileIds: [...winner.hand].sort(numericTileOrder),
      declaredMelds: winner.melds.map((meld) => ({
        ...meld,
        tileIds: [...meld.tileIds].sort(numericTileOrder),
      })),
    };
    if (
      state.turn !== state.result.winnerSeat ||
      canonicalJson(completedHand) !== canonicalJson(state.result.winningHand)
    ) {
      throw new Error("Completed result does not match the winning player.");
    }
  }
  assertConservation(state);
  assertStructuralCounts(state);
  if (state.phase === "exhausted" && state.wall.head !== state.wall.tail + 1) {
    throw new Error("An exhausted game must have no drawable wall tiles.");
  }
}

function assertV1State(value: unknown): asserts value is CanonicalGameStateV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "phase",
      "players",
      "ruleset",
      "schemaVersion",
      "sequence",
      "shuffleAlgorithm",
      "turn",
      "wall",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["ruleset"] !== "hong-kong/v1" ||
    value["shuffleAlgorithm"] !== HONG_KONG_V1_SHUFFLE_ALGORITHM ||
    !(
      [
        "awaiting-dealer-discard",
        "awaiting-draw",
        "awaiting-discard",
        "exhausted",
      ] as readonly string[]
    ).includes(value["phase"] as string)
  ) {
    throw new Error("Unsupported canonical game encoding.");
  }
  const state = value as unknown as CanonicalGameStateV1;
  assertCommonState(state);
  assertConservation(state);
  if (state.phase !== "exhausted") {
    const expected = state.phase === "awaiting-draw" ? 13 : 14;
    if (playerAt(state.players, state.turn).hand.length !== expected) {
      throw new Error("Turn hand size does not match the phase.");
    }
    for (const currentSeat of seats) {
      if (
        currentSeat !== state.turn &&
        playerAt(state.players, currentSeat).hand.length !== 13
      ) {
        throw new Error("Inactive player must hold 13 structural tiles.");
      }
    }
  } else if (
    state.wall.head !== state.wall.tail + 1 ||
    seats.some(
      (currentSeat) => playerAt(state.players, currentSeat).hand.length !== 13,
    )
  ) {
    throw new Error(
      "An exhausted legacy game must have an empty wall and 13-tile hands.",
    );
  }
}

function assertCommonState(state: VersionedCanonicalGameState): void {
  if (
    !seats.includes(state.turn) ||
    !Number.isSafeInteger(state.sequence) ||
    state.sequence < 1 ||
    !isRecord(state.wall) ||
    !hasExactKeys(state.wall, ["head", "order", "tail"]) ||
    !Array.isArray(state.wall.order) ||
    state.wall.order.length !== 144 ||
    !Number.isSafeInteger(state.wall.head) ||
    !Number.isSafeInteger(state.wall.tail) ||
    state.wall.head < 0 ||
    state.wall.tail >= 144 ||
    state.wall.head > state.wall.tail + 1 ||
    new Set(state.wall.order).size !== 144 ||
    state.wall.order.some((id) => !validTileId(id)) ||
    !isRecord(state.players) ||
    !hasExactKeys(state.players, seats)
  ) {
    throw new Error("Invalid canonical game state.");
  }
  for (const currentSeat of seats) {
    const player = playerAt(state.players, currentSeat);
    const expectedKeys =
      state.schemaVersion === 1
        ? ["actorId", "bonuses", "discards", "hand", "seat"]
        : ["actorId", "bonuses", "discards", "hand", "melds", "seat"];
    if (
      !isRecord(player) ||
      !hasExactKeys(player, expectedKeys) ||
      typeof player.actorId !== "string" ||
      player.actorId.length === 0 ||
      player.seat !== currentSeat ||
      !Array.isArray(player.bonuses) ||
      !Array.isArray(player.discards) ||
      !Array.isArray(player.hand) ||
      player.bonuses.some((id) => !validTileId(id) || !isBonusTile(id)) ||
      player.discards.some((id) => !validTileId(id) || isBonusTile(id)) ||
      player.hand.some((id) => !validTileId(id) || isBonusTile(id))
    ) {
      throw new Error(
        "Player tile locations violate kind or seat constraints.",
      );
    }
  }
  if (
    new Set(
      seats.map((currentSeat) => playerAt(state.players, currentSeat).actorId),
    ).size !== 4
  ) {
    throw new Error("Players must be distinct.");
  }
}

function assertCompletionProvenance(
  state: CanonicalGameStateV2,
): CompletionProvenance {
  const value: unknown = state.completionProvenance;
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    throw new Error("Complete state requires canonical win provenance.");
  }
  if (value["kind"] === "self-pick") {
    if (
      !hasExactKeys(value, [
        "acquiredTileWasFinalWall",
        "eastHadDeclaredKong",
        "eastHadDiscarded",
        "kind",
        "kongReplacementChainDepth",
        "lastAcquisition",
        "winnerSeat",
        "winningTileId",
      ]) ||
      typeof value["acquiredTileWasFinalWall"] !== "boolean" ||
      typeof value["eastHadDeclaredKong"] !== "boolean" ||
      typeof value["eastHadDiscarded"] !== "boolean" ||
      !Number.isSafeInteger(value["kongReplacementChainDepth"]) ||
      (value["kongReplacementChainDepth"] as number) < 0 ||
      !["bonus-replacement", "deal", "draw", "kong-replacement"].includes(
        value["lastAcquisition"] as string,
      ) ||
      !seats.includes(value["winnerSeat"] as Seat) ||
      !validTileId(value["winningTileId"])
    ) {
      throw new Error("Self-pick completion provenance is invalid.");
    }
    const provenance = value as unknown as Extract<
      CompletionProvenance,
      { readonly kind: "self-pick" }
    >;
    if (
      (provenance.lastAcquisition === "kong-replacement") !==
        provenance.kongReplacementChainDepth > 0 ||
      (provenance.acquiredTileWasFinalWall &&
        state.wall.head <= state.wall.tail) ||
      provenance.winnerSeat !== state.turn ||
      provenance.winningTileId !== state.turnProvenance.lastAcquiredTileId ||
      provenance.acquiredTileWasFinalWall !==
        state.turnProvenance.lastAcquiredTileWasFinalWall ||
      provenance.eastHadDeclaredKong !==
        state.turnProvenance.eastHasDeclaredKong ||
      provenance.eastHadDiscarded !== state.turnProvenance.eastHasDiscarded ||
      provenance.kongReplacementChainDepth !==
        state.turnProvenance.replacementChainDepth ||
      provenance.lastAcquisition !== state.turnProvenance.lastAcquisition
    ) {
      throw new Error("Self-pick provenance contradicts terminal state.");
    }
    return provenance;
  }
  if (
    (value["kind"] !== "discard" && value["kind"] !== "robbing-kong") ||
    !hasExactKeys(value, [
      "kind",
      "sourceIsOpeningEastDiscard",
      "sourceLastCatch",
      "sourceSeat",
      "winnerSeat",
      "winningTileId",
    ]) ||
    typeof value["sourceIsOpeningEastDiscard"] !== "boolean" ||
    typeof value["sourceLastCatch"] !== "boolean" ||
    !seats.includes(value["sourceSeat"] as Seat) ||
    !seats.includes(value["winnerSeat"] as Seat) ||
    value["sourceSeat"] === value["winnerSeat"] ||
    !validTileId(value["winningTileId"])
  ) {
    throw new Error("Reaction completion provenance is invalid.");
  }
  const provenance = value as unknown as Exclude<
    CompletionProvenance,
    { readonly kind: "self-pick" }
  >;
  if (
    (provenance.sourceIsOpeningEastDiscard &&
      (provenance.kind !== "discard" || provenance.sourceSeat !== "east")) ||
    (provenance.sourceLastCatch && state.wall.head <= state.wall.tail) ||
    provenance.winnerSeat !== state.turn ||
    state.turnProvenance.lastAcquiredTileId !== null ||
    state.turnProvenance.lastAcquiredTileWasFinalWall ||
    state.turnProvenance.lastAcquisition !== null ||
    state.turnProvenance.replacementChainDepth !== 0 ||
    state.turnProvenance.replacementPending ||
    !playerAt(state.players, provenance.winnerSeat).hand.includes(
      provenance.winningTileId,
    )
  ) {
    throw new Error("Reaction provenance contradicts terminal state.");
  }
  return provenance;
}

function assertTurnProvenance(state: CanonicalGameStateV2): void {
  const value: unknown = state.turnProvenance;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "eastHasDeclaredKong",
      "eastHasDiscarded",
      "lastAcquiredTileId",
      "lastAcquiredTileWasFinalWall",
      "lastAcquisition",
      "replacementChainDepth",
      "replacementPending",
    ]) ||
    typeof value["eastHasDeclaredKong"] !== "boolean" ||
    typeof value["eastHasDiscarded"] !== "boolean" ||
    !(
      value["lastAcquiredTileId"] === null ||
      validTileId(value["lastAcquiredTileId"])
    ) ||
    typeof value["lastAcquiredTileWasFinalWall"] !== "boolean" ||
    !(
      [null, "bonus-replacement", "deal", "draw", "kong-replacement"] as const
    ).includes(
      value["lastAcquisition"] as
        "bonus-replacement" | "deal" | "draw" | "kong-replacement" | null,
    ) ||
    !Number.isSafeInteger(value["replacementChainDepth"]) ||
    (value["replacementChainDepth"] as number) < 0 ||
    typeof value["replacementPending"] !== "boolean"
  ) {
    throw new Error("Invalid turn provenance.");
  }
  const provenance = state.turnProvenance;
  const active = playerAt(state.players, state.turn);
  const eastHasKong = state.players.east.melds.some(
    (meld) => meld.kind === "kong",
  );
  const activeKongCount = active.melds.filter(
    (meld) => meld.kind === "kong",
  ).length;
  const preDiscardPhase =
    state.phase === "awaiting-dealer-discard" ||
    state.phase === "awaiting-discard" ||
    state.phase === "awaiting-added-kong-reactions";
  const acquiredTileId = provenance.lastAcquiredTileId;
  const priorHeadTile = state.wall.order[state.wall.head - 1];
  const acquiredMatchesCanonicalWall =
    acquiredTileId === null ||
    provenance.lastAcquisition === null ||
    provenance.replacementPending
      ? true
      : provenance.lastAcquisition === "deal"
        ? true
        : provenance.lastAcquisition === "bonus-replacement" &&
            state.turn === seat("east") &&
            !provenance.eastHasDiscarded &&
            !provenance.eastHasDeclaredKong
          ? initialEastAcquisition(state).tileId === acquiredTileId &&
            initialEastAcquisition(state).acquisition ===
              provenance.lastAcquisition
          : provenance.lastAcquisition === "draw"
            ? state.wall.order[state.wall.head - 1] === acquiredTileId
            : provenance.lastAcquisition === "bonus-replacement"
              ? state.wall.order[state.wall.tail + 1] === acquiredTileId &&
                priorHeadTile !== undefined &&
                isBonusTile(priorHeadTile)
              : state.wall.order[state.wall.tail + 1] === acquiredTileId;
  const acquiredIsLocated =
    acquiredTileId === null ||
    active.hand.includes(acquiredTileId) ||
    active.melds.some((meld) => meld.tileIds.includes(acquiredTileId));
  if (
    (provenance.lastAcquisition === null) !==
      (provenance.lastAcquiredTileId === null) &&
    !(
      provenance.lastAcquisition === null &&
      acquiredTileId !== null &&
      active.melds.some((meld) => meld.tileIds.includes(acquiredTileId))
    )
  ) {
    throw new Error("Turn acquisition kind and tile are incoherent.");
  }
  if (!acquiredIsLocated) {
    throw new Error("The last acquired tile is not owned by the active seat.");
  }
  if (!acquiredMatchesCanonicalWall) {
    throw new Error("Turn acquisition contradicts the canonical wall.");
  }
  if (
    (!provenance.eastHasDiscarded && state.players.east.discards.length > 0) ||
    provenance.eastHasDeclaredKong !== eastHasKong ||
    (preDiscardPhase && provenance.lastAcquiredTileId === null) ||
    (provenance.lastAcquiredTileWasFinalWall &&
      (provenance.lastAcquiredTileId === null ||
        provenance.lastAcquisition === null ||
        state.wall.head <= state.wall.tail)) ||
    provenance.replacementChainDepth > Math.min(4, activeKongCount) ||
    (state.phase === "awaiting-dealer-discard" &&
      provenance.eastHasDiscarded) ||
    ((state.phase === "awaiting-draw" ||
      state.phase === "awaiting-discard-reactions") &&
      (provenance.lastAcquiredTileId !== null ||
        provenance.lastAcquisition !== null ||
        provenance.replacementPending)) ||
    (provenance.replacementPending &&
      state.phase !== "awaiting-dealer-discard" &&
      state.phase !== "awaiting-discard") ||
    (provenance.replacementPending &&
      !active.melds.some((meld) => meld.kind === "kong")) ||
    (provenance.lastAcquisition === "deal" &&
      (state.phase !== "awaiting-dealer-discard" ||
        state.turn !== seat("east") ||
        (!provenance.replacementPending &&
          provenance.replacementChainDepth !== 0))) ||
    ((provenance.lastAcquisition === "draw" ||
      provenance.lastAcquisition === "bonus-replacement" ||
      provenance.lastAcquisition === "kong-replacement") &&
      state.phase !== "awaiting-discard" &&
      state.phase !== "awaiting-added-kong-reactions" &&
      state.phase !== "pending-win-validation" &&
      state.phase !== "complete" &&
      !(
        (provenance.lastAcquisition === "bonus-replacement" ||
          provenance.lastAcquisition === "kong-replacement") &&
        state.phase === "awaiting-dealer-discard" &&
        state.turn === seat("east")
      )) ||
    (provenance.replacementChainDepth > 0 &&
      !provenance.replacementPending &&
      provenance.lastAcquisition !== "kong-replacement" &&
      !(state.phase === "exhausted" && provenance.lastAcquiredTileId === null))
  ) {
    throw new Error("Turn provenance contradicts canonical gameplay state.");
  }
}

function assertReactionWindow(state: CanonicalGameStateV2): void {
  const window = state.reactionWindow;
  if (window === null) {
    if (
      state.phase === "awaiting-discard-reactions" ||
      state.phase === "awaiting-added-kong-reactions"
    )
      throw new Error("Reaction phase requires an open window.");
    if (
      state.phase === "pending-win-validation" &&
      scoreSelfWinCandidate(
        { ...state, phase: "awaiting-discard" },
        state.turn,
      ) === null
    ) {
      throw new Error("Pending self win must reproduce a legal score.");
    }
    return;
  }
  const expectedKeys =
    window.kind === "discard"
      ? [
          "id",
          "intents",
          "kind",
          "openingSequence",
          "responderOrder",
          "sourceIsOpeningEastDiscard",
          "sourceLastCatch",
          "sourceSeat",
          "sourceTileId",
        ]
      : [
          "id",
          "intents",
          "kind",
          "openingSequence",
          "responderOrder",
          "sourceIsOpeningEastDiscard",
          "sourceLastCatch",
          "sourceMeldId",
          "sourceSeat",
          "sourceTileId",
        ];
  if (
    !isRecord(window) ||
    !hasExactKeys(window, expectedKeys) ||
    !["discard", "added-kong"].includes(window.kind) ||
    !validTileId(window.sourceTileId) ||
    !seats.includes(window.sourceSeat) ||
    !Array.isArray(window.responderOrder) ||
    canonicalJson(window.responderOrder) !==
      canonicalJson(threeSeatsAfter(window.sourceSeat)) ||
    !isRecord(window.intents) ||
    typeof window.sourceIsOpeningEastDiscard !== "boolean" ||
    typeof window.sourceLastCatch !== "boolean" ||
    !Number.isSafeInteger(window.openingSequence) ||
    window.openingSequence < 1 ||
    window.openingSequence > state.sequence ||
    window.id !== `${window.kind}:${String(window.openingSequence)}` ||
    (window.kind === "discard" &&
      state.phase !== "awaiting-discard-reactions" &&
      state.phase !== "pending-win-validation") ||
    (window.kind === "added-kong" &&
      state.phase !== "awaiting-added-kong-reactions" &&
      state.phase !== "pending-win-validation")
  ) {
    throw new Error("Invalid reaction window.");
  }
  const source = playerAt(state.players, window.sourceSeat);
  if (
    (window.sourceIsOpeningEastDiscard &&
      (window.kind !== "discard" || window.sourceSeat !== seat("east"))) ||
    (window.sourceLastCatch && state.wall.head <= state.wall.tail) ||
    (window.kind === "discard" &&
      source.discards.at(-1) !== window.sourceTileId) ||
    (window.kind === "added-kong" &&
      (!source.hand.includes(window.sourceTileId) ||
        !source.melds.some((meld) => meld.id === window.sourceMeldId)))
  ) {
    throw new Error("Reaction source does not match canonical tile locations.");
  }
  if (
    state.phase === "pending-win-validation" &&
    normalizeReactionWindow(state, window).outcome.type !== "structural-win"
  ) {
    throw new Error("Pending win validation requires a structural win.");
  }
  for (const [actorId, intent] of Object.entries(window.intents)) {
    if (!isRecord(intent) || !hasExactKeys(intent, ["response", "seat"])) {
      throw new Error("Invalid canonical reaction intent.");
    }
    const submitted = intent as unknown as SubmittedReactionIntent;
    if (
      playerAt(state.players, submitted.seat).actorId !== actorId ||
      !window.responderOrder.includes(submitted.seat) ||
      !validReactionResponse(submitted.response) ||
      !isLegalReaction(state, submitted.seat, submitted.response, {
        includeStructuralWin: true,
      }) ||
      (submitted.response.type === "win" &&
        scoreReactionWinCandidate(state, submitted.seat) === null)
    )
      throw new Error("Reaction intent actor or response is invalid.");
  }
}

function assertMeld(value: unknown): asserts value is DeclaredMeld {
  if (!isRecord(value)) throw new Error("Declared meld must be an object.");
  const optionalKeys = ["claimedTileId", "kongKind", "sourceSeat"];
  const requiredKeys = ["exposure", "id", "kind", "tileIds"];
  const actual = Object.keys(value);
  if (
    requiredKeys.some((key) => !actual.includes(key)) ||
    actual.some(
      (key) => !requiredKeys.includes(key) && !optionalKeys.includes(key),
    ) ||
    typeof value["id"] !== "string" ||
    value["id"].length === 0 ||
    !["concealed", "exposed"].includes(value["exposure"] as string) ||
    !["chow", "pung", "kong"].includes(value["kind"] as string) ||
    (value["claimedTileId"] !== undefined &&
      !validTileId(value["claimedTileId"])) ||
    (value["kongKind"] !== undefined &&
      !["added", "concealed", "exposed"].includes(
        value["kongKind"] as string,
      )) ||
    (value["sourceSeat"] !== undefined &&
      !seats.includes(value["sourceSeat"] as Seat)) ||
    !Array.isArray(value["tileIds"]) ||
    value["tileIds"].some((id) => !validTileId(id)) ||
    numericIds(value["tileIds"] as TileId[]) !==
      numericIds(canonicalTileIds(value["tileIds"] as TileId[]))
  )
    throw new Error("Declared meld encoding is invalid.");
  const meld = value as unknown as DeclaredMeld;
  const firstTileId = meld.tileIds[0];
  if (
    firstTileId === undefined ||
    (meld.kind === "kong" && meld.tileIds.length !== 4) ||
    (meld.kind !== "kong" && meld.tileIds.length !== 3) ||
    new Set(meld.tileIds).size !== meld.tileIds.length ||
    (meld.kind === "kong") !== (meld.kongKind !== undefined) ||
    (meld.exposure === "concealed" &&
      (meld.kind !== "kong" ||
        meld.kongKind !== "concealed" ||
        meld.claimedTileId !== undefined ||
        meld.sourceSeat !== undefined)) ||
    (meld.exposure === "exposed" &&
      (meld.claimedTileId === undefined ||
        meld.sourceSeat === undefined ||
        !meld.tileIds.includes(meld.claimedTileId))) ||
    (meld.tileIds.some((id) => !sameTileKind(id, firstTileId)) &&
      meld.kind !== "chow")
  )
    throw new Error("Declared meld physical tiles are invalid.");
  if (meld.kind === "chow") {
    const kinds = meld.tileIds.map(tileKind);
    const suitedKinds = kinds.filter((kind) => kind.type === "suited");
    if (
      suitedKinds.length !== kinds.length ||
      new Set(suitedKinds.map((kind) => kind.suit)).size !== 1 ||
      suitedKinds
        .map((kind) => kind.rank)
        .sort((left, right) => left - right)
        .some(
          (rank, index, ranks) => index > 0 && rank !== (ranks[0] ?? 0) + index,
        )
    )
      throw new Error("Chow meld is not one suited sequence.");
  }
}

function assertConservation(state: VersionedCanonicalGameState): void {
  const locations = [
    ...state.wall.order.slice(state.wall.head, state.wall.tail + 1),
    ...seats.flatMap((currentSeat) => {
      const player = playerAt(state.players, currentSeat);
      return [
        ...player.hand,
        ...player.bonuses,
        ...player.discards,
        ...(state.schemaVersion === 2
          ? playerAt(state.players, currentSeat).melds.flatMap(
              (meld) => meld.tileIds,
            )
          : []),
      ];
    }),
  ];
  if (locations.length !== 144 || new Set(locations).size !== 144) {
    throw new Error("Every physical tile must occupy exactly one location.");
  }
}

function assertStructuralCounts(state: CanonicalGameStateV2): void {
  for (const currentSeat of seats) {
    const player = playerAt(state.players, currentSeat);
    const structuralCount = player.hand.length + 3 * player.melds.length;
    let expected = 13;
    if (
      state.phase === "complete" &&
      currentSeat === state.result?.winnerSeat
    ) {
      expected = 14;
    }
    if (
      currentSeat === state.turn &&
      (state.phase === "awaiting-dealer-discard" ||
        state.phase === "awaiting-discard" ||
        state.phase === "awaiting-added-kong-reactions" ||
        (state.phase === "pending-win-validation" &&
          state.reactionWindow === null) ||
        (state.phase === "pending-win-validation" &&
          state.reactionWindow?.kind === "added-kong"))
    )
      expected = state.turnProvenance.replacementPending ? 13 : 14;
    if (structuralCount !== expected) {
      throw new Error(
        "Structural hand size does not match phase and meld count.",
      );
    }
  }
}

export function assertVersionedGameEvent(
  value: unknown,
): asserts value is VersionedHongKongGameEvent {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Canonical game event must be an object.");
  }
  const sequence = value["sequence"];
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    throw new Error("Canonical game event has an invalid sequence.");
  }
  switch (value["type"]) {
    case "game/started":
      if (
        !hasExactKeys(value, ["sequence", "state", "type"]) ||
        sequence !== 1
      ) {
        throw new Error("Canonical genesis event is invalid.");
      }
      assertGameInvariants(value["state"]);
      if (
        value["state"].sequence !== 1 ||
        (value["state"].schemaVersion === 2 &&
          value["state"].phase === "pending-win-validation")
      )
        throw new Error("Genesis state is not deployable.");
      return;
    case "game/tile-discarded":
      assertExactEvent(value, ["seat", "sequence", "tileId", "type"]);
      assertSeatAndTile(value);
      return;
    case "game/turn-drawn":
      assertExactEvent(value, [
        "exhausted",
        "ordinaryTileId",
        "replacementTileIds",
        "seat",
        "sequence",
        "type",
      ]);
      if (
        typeof value["exhausted"] !== "boolean" ||
        !validTileId(value["ordinaryTileId"]) ||
        !Array.isArray(value["replacementTileIds"]) ||
        value["replacementTileIds"].some((id) => !validTileId(id)) ||
        !seats.includes(value["seat"] as Seat)
      )
        throw new Error("Canonical draw event is invalid.");
      return;
    case "game/wall-exhausted":
      assertExactEvent(value, ["requiredDraw", "seat", "sequence", "type"]);
      if (
        value["requiredDraw"] !== "ordinary" ||
        !seats.includes(value["seat"] as Seat)
      ) {
        throw new Error("Canonical exhaustion event is invalid.");
      }
      return;
    case "game/state-upgraded":
      assertExactEvent(value, [
        "fromSchemaVersion",
        "provenance",
        "sequence",
        "toSchemaVersion",
        "type",
      ]);
      if (value["fromSchemaVersion"] !== 1 || value["toSchemaVersion"] !== 2) {
        throw new Error("Invalid state upgrade.");
      }
      assertLegacyUpgradeProvenance(value["provenance"]);
      return;
    case "game/discard-reaction-opened":
      assertExactEvent(value, [
        "seat",
        "sequence",
        "tileId",
        "type",
        "windowId",
      ]);
      assertSeatAndTile(value);
      if (typeof value["windowId"] !== "string")
        throw new Error("Invalid window ID.");
      return;
    case "game/reaction-intent-submitted":
      assertExactEvent(value, [
        "actorId",
        "response",
        "seat",
        "sequence",
        "type",
        "windowId",
      ]);
      if (
        typeof value["actorId"] !== "string" ||
        typeof value["windowId"] !== "string" ||
        !seats.includes(value["seat"] as Seat) ||
        !validReactionResponse(value["response"])
      )
        throw new Error("Invalid reaction intent event.");
      return;
    case "game/reaction-resolved":
      assertExactEvent(value, [
        "outcome",
        "responses",
        "sequence",
        "type",
        "windowId",
      ]);
      if (
        typeof value["windowId"] !== "string" ||
        !Array.isArray(value["responses"]) ||
        value["responses"].length !== 3 ||
        !validReactionOutcome(value["outcome"]) ||
        value["responses"].some((entry) => !validNormalizedReaction(entry)) ||
        new Set(
          value["responses"].map((entry) =>
            isRecord(entry) ? entry["seat"] : null,
          ),
        ).size !== 3
      )
        throw new Error("Invalid reaction resolution event.");
      return;
    case "game/concealed-kong-declared":
      assertExactEvent(value, ["meld", "seat", "sequence", "type"]);
      if (!seats.includes(value["seat"] as Seat))
        throw new Error("Invalid kong seat.");
      assertMeld(value["meld"]);
      return;
    case "game/added-kong-proposed":
      assertExactEvent(value, [
        "meldId",
        "seat",
        "sequence",
        "tileId",
        "type",
        "windowId",
      ]);
      assertSeatAndTile(value);
      if (
        typeof value["meldId"] !== "string" ||
        typeof value["windowId"] !== "string"
      ) {
        throw new Error("Invalid added kong proposal.");
      }
      return;
    case "game/kong-replacement-drawn":
      assertExactEvent(value, [
        "exhausted",
        "seat",
        "sequence",
        "tileIds",
        "type",
      ]);
      if (
        typeof value["exhausted"] !== "boolean" ||
        !seats.includes(value["seat"] as Seat) ||
        !Array.isArray(value["tileIds"]) ||
        value["tileIds"].some((id) => !validTileId(id))
      )
        throw new Error("Invalid kong replacement event.");
      return;
    case "game/self-win-declared":
      assertExactEvent(value, ["seat", "sequence", "type"]);
      if (!seats.includes(value["seat"] as Seat)) {
        throw new Error("Invalid self-win seat.");
      }
      return;
    case "game/hand-completed":
      assertExactEvent(value, ["result", "sequence", "type"]);
      assertCompletedHandResult(value["result"]);
      return;
    default:
      throw new Error("Unknown canonical game event type.");
  }
}

export function assertLegacyGameEvent(
  value: unknown,
): asserts value is HongKongGameEvent {
  assertVersionedGameEvent(value);
  if (
    value.type === "game/started"
      ? value.state.schemaVersion !== 1
      : ![
          "game/tile-discarded",
          "game/turn-drawn",
          "game/wall-exhausted",
        ].includes(value.type)
  ) {
    throw new Error("Event is outside the schema-v1 contract.");
  }
}

function assertLegacyUpgradeProvenance(
  value: unknown,
): asserts value is LegacyUpgradeProvenance {
  if (
    !isRecord(value) ||
    typeof value["eastHasDiscarded"] !== "boolean" ||
    !Number.isSafeInteger(value["sourceSequence"]) ||
    (value["sourceSequence"] as number) < 1 ||
    typeof value["type"] !== "string"
  ) {
    throw new Error("Invalid legacy upgrade provenance.");
  }
  if (value["type"] === "initial-deal") {
    if (
      !hasExactKeys(value, ["eastHasDiscarded", "sourceSequence", "type"]) ||
      value["sourceSequence"] !== 1
    ) {
      throw new Error("Invalid initial-deal upgrade provenance.");
    }
    return;
  }
  if (value["type"] === "discard") {
    assertExactEvent(value, [
      "eastHasDiscarded",
      "seat",
      "sourceSequence",
      "tileId",
      "type",
    ]);
    assertSeatAndTile(value);
    return;
  }
  if (value["type"] === "wall-exhausted") {
    assertExactEvent(value, [
      "eastHasDiscarded",
      "requiredDraw",
      "seat",
      "sourceSequence",
      "type",
    ]);
    if (
      value["requiredDraw"] !== "ordinary" ||
      !seats.includes(value["seat"] as Seat)
    ) {
      throw new Error("Invalid exhausted upgrade provenance.");
    }
    return;
  }
  if (value["type"] === "draw") {
    assertExactEvent(value, [
      "eastHasDiscarded",
      "exhausted",
      "ordinaryTileId",
      "replacementTileIds",
      "seat",
      "sourceSequence",
      "type",
    ]);
    if (
      typeof value["exhausted"] !== "boolean" ||
      !validTileId(value["ordinaryTileId"]) ||
      !Array.isArray(value["replacementTileIds"]) ||
      value["replacementTileIds"].some((tileId) => !validTileId(tileId)) ||
      !seats.includes(value["seat"] as Seat)
    ) {
      throw new Error("Invalid draw upgrade provenance.");
    }
    return;
  }
  throw new Error("Unknown legacy upgrade provenance type.");
}

function validReactionResponse(value: unknown): value is ReactionResponse {
  if (!isRecord(value) || typeof value["type"] !== "string") return false;
  if (value["type"] === "pass") return hasExactKeys(value, ["type"]);
  if (value["type"] === "win") {
    return (
      hasExactKeys(value, ["structurallyEligible", "type"]) &&
      value["structurallyEligible"] === true
    );
  }
  const length = value["type"] === "kong" ? 3 : 2;
  return (
    ["chow", "pung", "kong"].includes(value["type"]) &&
    hasExactKeys(value, ["handTileIds", "type"]) &&
    Array.isArray(value["handTileIds"]) &&
    value["handTileIds"].length === length &&
    value["handTileIds"].every((id) => validTileId(id)) &&
    new Set(value["handTileIds"]).size === length &&
    numericIds(value["handTileIds"]) ===
      numericIds(canonicalTileIds(value["handTileIds"]))
  );
}

function validNormalizedReaction(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["response", "seat"]) &&
    seats.includes(value["seat"] as Seat) &&
    validReactionResponse(value["response"])
  );
}

function validReactionOutcome(value: unknown): boolean {
  if (!isRecord(value) || typeof value["type"] !== "string") return false;
  if (value["type"] === "all-pass") return hasExactKeys(value, ["type"]);
  if (value["type"] === "structural-win") {
    return (
      hasExactKeys(value, ["seats", "type"]) &&
      Array.isArray(value["seats"]) &&
      value["seats"].length > 0 &&
      value["seats"].every((currentSeat) =>
        seats.includes(currentSeat as Seat),
      ) &&
      new Set(value["seats"]).size === value["seats"].length
    );
  }
  return (
    value["type"] === "claim" &&
    hasExactKeys(value, ["response", "seat", "type"]) &&
    seats.includes(value["seat"] as Seat) &&
    validReactionResponse(value["response"]) &&
    ["chow", "pung", "kong"].includes(value["response"].type)
  );
}

function assertExactEvent(value: object, keys: readonly string[]): void {
  if (!hasExactKeys(value, keys))
    throw new Error("Canonical event has unknown or missing fields.");
}

function assertSeatAndTile(value: Record<string, unknown>): void {
  if (!seats.includes(value["seat"] as Seat) || !validTileId(value["tileId"])) {
    throw new Error("Canonical event seat or tile is invalid.");
  }
}

function validTileId(value: unknown): value is TileId {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < 144
  );
}

function threeSeatsAfter(source: Seat): readonly [Seat, Seat, Seat] {
  const first = nextSeat(source);
  const second = nextSeat(first);
  return [first, second, nextSeat(second)];
}

function numericIds(tileIds: readonly TileId[]): string {
  return tileIds.map(Number).join(",");
}

function numericTileOrder(left: TileId, right: TileId): number {
  return Number(left) - Number(right);
}
