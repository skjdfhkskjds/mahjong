import {
  nextSeat,
  seat,
  seats,
  type Seat,
  type TileId,
} from "@mahjong/game-core";

import type { DeclaredMeld } from "../melds/meld.js";
import type { HandDecomposition } from "../scoring/decompose-hand.js";
import type { DetectedPattern } from "../scoring/detect-patterns.js";
import {
  createScoringHandFixture,
  type ScoringHandFixture,
  type WinningConditions,
  type WinningTileSource,
} from "../scoring/hand-fixture.js";
import type { SeatPayments } from "../scoring/payments.js";
import {
  scoreHongKongHand,
  type HongKongHandScore,
} from "../scoring/score-hand.js";
import type { SuppressedPattern } from "../scoring/award-patterns.js";
import { canonicalJson, hasExactKeys, isRecord } from "./game-codec.js";
import {
  playerAt,
  type CanonicalGameStateV2,
  type CompletionProvenance,
  type ReactionWindow,
} from "./game-state.js";

export interface WinningPhysicalHand {
  readonly bonusTileIds: readonly TileId[];
  readonly concealedTileIds: readonly TileId[];
  readonly declaredMelds: readonly DeclaredMeld[];
}

export interface CompletedHandResult {
  readonly awardedPatterns: readonly DetectedPattern[];
  readonly bonusFaan: number;
  readonly cappedFaan: number;
  readonly decomposition: HandDecomposition;
  readonly detectedPatterns: readonly DetectedPattern[];
  readonly eligibilityFaan: number;
  readonly explanation: HongKongHandScore["explanation"];
  readonly isLegalWin: true;
  readonly payments: SeatPayments;
  readonly rawFaan: number;
  readonly source: WinningTileSource;
  readonly suppressedPatterns: readonly SuppressedPattern[];
  readonly tablePoints: number;
  readonly winnerSeat: Seat;
  readonly winningConditions: WinningConditions;
  readonly winningHand: WinningPhysicalHand;
  readonly winningTileId: TileId;
}

function completedResult(
  fixture: ScoringHandFixture,
  score: HongKongHandScore,
): CompletedHandResult {
  return {
    awardedPatterns: score.awardedPatterns,
    bonusFaan: score.bonusFaan,
    cappedFaan: score.cappedFaan,
    decomposition: score.decomposition,
    detectedPatterns: score.detectedPatterns,
    eligibilityFaan: score.eligibilityFaan,
    explanation: score.explanation,
    isLegalWin: true,
    payments: score.payments,
    rawFaan: score.rawFaan,
    source: fixture.winningTileSource,
    suppressedPatterns: score.suppressedPatterns,
    tablePoints: score.tablePoints,
    winnerSeat: fixture.winnerSeat,
    winningConditions: fixture.winningConditions,
    winningHand: {
      bonusTileIds: fixture.bonusTileIds,
      concealedTileIds: fixture.concealedTileIds,
      declaredMelds: fixture.declaredMelds,
    },
    winningTileId: fixture.winningTileId,
  };
}

function scoreFixture(fixture: ScoringHandFixture): CompletedHandResult | null {
  const score = scoreHongKongHand(fixture);
  return score === null ? null : completedResult(fixture, score);
}

function selfWinningConditions(
  state: CanonicalGameStateV2,
  winnerSeat: Seat,
): WinningConditions {
  const opening =
    winnerSeat === "east" &&
    !state.turnProvenance.eastHasDiscarded &&
    !state.turnProvenance.eastHasDeclaredKong
      ? "heavenly"
      : "none";
  const replacement =
    state.turnProvenance.lastAcquisition === "bonus-replacement"
      ? "bonus"
      : state.turnProvenance.lastAcquisition !== "kong-replacement"
        ? "none"
        : state.turnProvenance.replacementChainDepth >= 2
          ? "double-kong"
          : "kong";
  return {
    opening,
    replacement,
    wallPosition: state.turnProvenance.lastAcquiredTileWasFinalWall
      ? "final-wall-tile"
      : "ordinary",
  };
}

function reactionWinningConditions(
  window: ReactionWindow,
  winnerSeat: Seat,
): WinningConditions {
  return {
    opening:
      winnerSeat !== "east" && window.sourceIsOpeningEastDiscard
        ? "earthly"
        : "none",
    replacement: "none",
    wallPosition: window.sourceLastCatch
      ? window.kind === "discard"
        ? "discard-after-final-wall-tile"
        : "final-wall-tile"
      : "ordinary",
  };
}

export function scoreSelfWinCandidate(
  state: CanonicalGameStateV2,
  winnerSeat: Seat,
): CompletedHandResult | null {
  const winningTileId = state.turnProvenance.lastAcquiredTileId;
  const player = playerAt(state.players, winnerSeat);
  if (
    winnerSeat !== state.turn ||
    state.reactionWindow !== null ||
    (state.phase !== "awaiting-dealer-discard" &&
      state.phase !== "awaiting-discard") ||
    state.turnProvenance.replacementPending ||
    state.turnProvenance.lastAcquisition === null ||
    winningTileId === null ||
    !player.hand.includes(winningTileId)
  ) {
    return null;
  }
  const fixture = createScoringHandFixture({
    bonusTileIds: player.bonuses,
    concealedTileIds: player.hand,
    declaredMelds: player.melds,
    prevailingWind: seat(state.prevailingWind),
    winnerSeat,
    winningConditions: selfWinningConditions(state, winnerSeat),
    winningTileId,
    winningTileSource: { type: "self-pick" },
  });
  return scoreFixture(fixture);
}

export function scoreReactionWinCandidate(
  state: CanonicalGameStateV2,
  winnerSeat: Seat,
): CompletedHandResult | null {
  const window = state.reactionWindow;
  if (!window?.responderOrder.includes(winnerSeat)) {
    return null;
  }
  const player = playerAt(state.players, winnerSeat);
  const source: WinningTileSource =
    window.kind === "added-kong"
      ? { type: "robbing-kong", sourceSeat: window.sourceSeat }
      : { type: "discard", sourceSeat: window.sourceSeat };
  const fixture = createScoringHandFixture({
    bonusTileIds: player.bonuses,
    concealedTileIds: [...player.hand, window.sourceTileId],
    declaredMelds: player.melds,
    prevailingWind: seat(state.prevailingWind),
    winnerSeat,
    winningConditions: reactionWinningConditions(window, winnerSeat),
    winningTileId: window.sourceTileId,
    winningTileSource: source,
  });
  return scoreFixture(fixture);
}

export function resolveScoredReactionWinner(
  state: CanonicalGameStateV2,
  candidateSeats: readonly Seat[],
): CompletedHandResult | null {
  const window = state.reactionWindow;
  if (window === null) return null;
  const candidates = candidateSeats.flatMap((candidateSeat) => {
    const result = scoreReactionWinCandidate(state, candidateSeat);
    return result === null ? [] : [result];
  });
  return (
    candidates.sort(
      (left, right) =>
        right.cappedFaan - left.cappedFaan ||
        turnDistance(window.sourceSeat, left.winnerSeat) -
          turnDistance(window.sourceSeat, right.winnerSeat),
    )[0] ?? null
  );
}

export function expectedPendingCompletion(
  state: CanonicalGameStateV2,
): CompletedHandResult {
  if (state.phase !== "pending-win-validation") {
    throw new Error("Hand completion requires pending win validation.");
  }
  if (state.reactionWindow === null) {
    const result = scoreSelfWinCandidate(
      { ...state, phase: "awaiting-discard" },
      state.turn,
    );
    if (result === null) throw new Error("Pending self win is not scoreable.");
    return result;
  }
  const winnerSeats = state.reactionWindow.responderOrder.filter((seat) => {
    const actorId = playerAt(state.players, seat).actorId;
    return state.reactionWindow?.intents[actorId]?.response.type === "win";
  });
  const result = resolveScoredReactionWinner(state, winnerSeats);
  if (result === null) throw new Error("Pending reaction has no legal winner.");
  return result;
}

export function completionProvenanceFor(
  state: CanonicalGameStateV2,
  result: CompletedHandResult,
): CompletionProvenance {
  if (state.phase !== "pending-win-validation") {
    throw new Error("Completion provenance requires pending validation.");
  }
  const window = state.reactionWindow;
  if (window === null) {
    const lastAcquisition = state.turnProvenance.lastAcquisition;
    const winningTileId = state.turnProvenance.lastAcquiredTileId;
    if (lastAcquisition === null || winningTileId === null) {
      throw new Error("Pending self win lacks acquisition provenance.");
    }
    return {
      acquiredTileWasFinalWall:
        state.turnProvenance.lastAcquiredTileWasFinalWall,
      eastHadDeclaredKong: state.turnProvenance.eastHasDeclaredKong,
      eastHadDiscarded: state.turnProvenance.eastHasDiscarded,
      kind: "self-pick",
      kongReplacementChainDepth: state.turnProvenance.replacementChainDepth,
      lastAcquisition,
      winnerSeat: result.winnerSeat,
      winningTileId,
    };
  }
  return {
    kind: window.kind === "discard" ? "discard" : "robbing-kong",
    sourceIsOpeningEastDiscard: window.sourceIsOpeningEastDiscard,
    sourceLastCatch: window.sourceLastCatch,
    sourceSeat: window.sourceSeat,
    winnerSeat: result.winnerSeat,
    winningTileId: window.sourceTileId,
  };
}

export function assertResultMatchesCompletionProvenance(
  result: CompletedHandResult,
  provenance: CompletionProvenance,
): void {
  const expectedSource: WinningTileSource =
    provenance.kind === "self-pick"
      ? { type: "self-pick" }
      : {
          type: provenance.kind,
          sourceSeat: provenance.sourceSeat,
        };
  const expectedConditions: WinningConditions =
    provenance.kind === "self-pick"
      ? {
          opening:
            provenance.winnerSeat === "east" &&
            !provenance.eastHadDiscarded &&
            !provenance.eastHadDeclaredKong
              ? "heavenly"
              : "none",
          replacement:
            provenance.lastAcquisition === "bonus-replacement"
              ? "bonus"
              : provenance.lastAcquisition === "kong-replacement"
                ? provenance.kongReplacementChainDepth >= 2
                  ? "double-kong"
                  : "kong"
                : "none",
          wallPosition: provenance.acquiredTileWasFinalWall
            ? "final-wall-tile"
            : "ordinary",
        }
      : {
          opening:
            provenance.kind === "discard" &&
            provenance.winnerSeat !== "east" &&
            provenance.sourceIsOpeningEastDiscard
              ? "earthly"
              : "none",
          replacement: "none",
          wallPosition: provenance.sourceLastCatch
            ? provenance.kind === "discard"
              ? "discard-after-final-wall-tile"
              : "final-wall-tile"
            : "ordinary",
        };
  if (
    result.winnerSeat !== provenance.winnerSeat ||
    result.winningTileId !== provenance.winningTileId ||
    canonicalJson(result.source) !== canonicalJson(expectedSource) ||
    canonicalJson(result.winningConditions) !==
      canonicalJson(expectedConditions)
  ) {
    throw new Error("Completed score contradicts canonical provenance.");
  }
}

function turnDistance(source: Seat, candidate: Seat): number {
  let current = source;
  for (let distance = 1; distance <= 3; distance += 1) {
    current = nextSeat(current);
    if (current === candidate) return distance;
  }
  throw new Error("Winner must differ from the source seat.");
}

const RESULT_KEYS = [
  "awardedPatterns",
  "bonusFaan",
  "cappedFaan",
  "decomposition",
  "detectedPatterns",
  "eligibilityFaan",
  "explanation",
  "isLegalWin",
  "payments",
  "rawFaan",
  "source",
  "suppressedPatterns",
  "tablePoints",
  "winnerSeat",
  "winningConditions",
  "winningHand",
  "winningTileId",
] as const;

export function assertCompletedHandResult(
  value: unknown,
): asserts value is CompletedHandResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RESULT_KEYS) ||
    value["isLegalWin"] !== true ||
    !seats.includes(value["winnerSeat"] as Seat) ||
    !validTileId(value["winningTileId"]) ||
    !isRecord(value["winningHand"]) ||
    !hasExactKeys(value["winningHand"], [
      "bonusTileIds",
      "concealedTileIds",
      "declaredMelds",
    ]) ||
    !Array.isArray(value["winningHand"]["bonusTileIds"]) ||
    !Array.isArray(value["winningHand"]["concealedTileIds"]) ||
    !Array.isArray(value["winningHand"]["declaredMelds"]) ||
    !validWinningSource(value["source"]) ||
    !validWinningConditions(value["winningConditions"])
  ) {
    throw new Error("Completed hand result has an invalid encoding.");
  }
  for (const meld of value["winningHand"]["declaredMelds"]) {
    if (!isRecord(meld) || !hasOnlyMeldKeys(meld)) {
      throw new Error("Completed hand meld has an invalid encoding.");
    }
  }
  const candidate = value as unknown as CompletedHandResult;
  const fixture = createScoringHandFixture({
    bonusTileIds: candidate.winningHand.bonusTileIds,
    concealedTileIds: candidate.winningHand.concealedTileIds,
    declaredMelds: candidate.winningHand.declaredMelds,
    prevailingWind: seat("east"),
    winnerSeat: candidate.winnerSeat,
    winningConditions: candidate.winningConditions,
    winningTileId: candidate.winningTileId,
    winningTileSource: candidate.source,
  });
  const score = scoreHongKongHand(fixture);
  if (
    score === null ||
    canonicalJson(completedResult(fixture, score)) !== canonicalJson(candidate)
  ) {
    throw new Error("Completed hand result does not reproduce its score.");
  }
}

function validWinningSource(value: unknown): value is WinningTileSource {
  if (!isRecord(value) || typeof value["type"] !== "string") return false;
  if (value["type"] === "self-pick") return hasExactKeys(value, ["type"]);
  return (
    (value["type"] === "discard" || value["type"] === "robbing-kong") &&
    hasExactKeys(value, ["sourceSeat", "type"]) &&
    seats.includes(value["sourceSeat"] as Seat)
  );
}

function validWinningConditions(value: unknown): value is WinningConditions {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["opening", "replacement", "wallPosition"]) &&
    ["earthly", "heavenly", "none"].includes(value["opening"] as string) &&
    ["bonus", "double-kong", "kong", "none"].includes(
      value["replacement"] as string,
    ) &&
    ["discard-after-final-wall-tile", "final-wall-tile", "ordinary"].includes(
      value["wallPosition"] as string,
    )
  );
}

function hasOnlyMeldKeys(value: object): boolean {
  const required = ["exposure", "id", "kind", "tileIds"];
  const allowed = [...required, "claimedTileId", "kongKind", "sourceSeat"];
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.includes(key))
  );
}

function validTileId(value: unknown): value is TileId {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < 144
  );
}
