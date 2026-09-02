import type { HandDecomposition } from "./decompose-hand.js";
import { decomposeWinningHand } from "./decompose-hand.js";
import type { DetectedPattern, PatternId } from "./detect-patterns.js";
import { detectPatterns } from "./detect-patterns.js";
import type { ScoringHandFixture } from "./hand-fixture.js";
import type { SeatPayments } from "./payments.js";
import { calculatePayments, halfSpicyPoints } from "./payments.js";
import type { SuppressedPattern } from "./award-patterns.js";
import { awardPatterns } from "./award-patterns.js";

export interface ScoredDecomposition {
  readonly awardedPatterns: readonly DetectedPattern[];
  readonly bonusFaan: number;
  readonly cappedFaan: number;
  readonly decomposition: HandDecomposition;
  readonly detectedPatterns: readonly DetectedPattern[];
  readonly eligibilityFaan: number;
  readonly isLegalWin: boolean;
  readonly rawFaan: number;
  readonly suppressedPatterns: readonly SuppressedPattern[];
}

export interface HongKongHandScore extends ScoredDecomposition {
  readonly explanation: {
    readonly awardedPatternIds: readonly PatternId[];
    readonly suppressed: readonly {
      readonly by: PatternId;
      readonly patternId: PatternId;
      readonly reason: SuppressedPattern["reason"];
    }[];
  };
  readonly payments: SeatPayments;
  readonly tablePoints: number;
}

function sumFaan(patterns: readonly DetectedPattern[]): number {
  return patterns.reduce((sum, candidate) => sum + candidate.faan, 0);
}

export function scoreDecomposition(
  fixture: ScoringHandFixture,
  decomposition: HandDecomposition,
): ScoredDecomposition {
  const detectedPatterns = detectPatterns(fixture, decomposition);
  const { awarded, suppressed } = awardPatterns(detectedPatterns);
  const bonusFaan = sumFaan(
    awarded.filter((candidate) => candidate.category === "bonus"),
  );
  const eligibilityFaan = sumFaan(
    awarded.filter((candidate) => candidate.category !== "bonus"),
  );
  const isLegalWin = eligibilityFaan >= 3;
  const rawFaan = sumFaan(awarded);
  return {
    awardedPatterns: awarded,
    bonusFaan,
    cappedFaan: Math.min(rawFaan, 13),
    decomposition,
    detectedPatterns,
    eligibilityFaan,
    isLegalWin,
    rawFaan,
    suppressedPatterns: suppressed,
  };
}

function awardedEncoding(score: ScoredDecomposition): string {
  return score.awardedPatterns.map((candidate) => candidate.id).join("|");
}

function compareScores(
  left: ScoredDecomposition,
  right: ScoredDecomposition,
): number {
  return (
    right.cappedFaan - left.cappedFaan ||
    awardedEncoding(left).localeCompare(awardedEncoding(right)) ||
    left.decomposition.encoding.localeCompare(right.decomposition.encoding)
  );
}

export function scoreHongKongHand(
  fixture: ScoringHandFixture,
): HongKongHandScore | null {
  const best = decomposeWinningHand(fixture)
    .map((decomposition) => scoreDecomposition(fixture, decomposition))
    .filter((candidate) => candidate.isLegalWin)
    .sort(compareScores)[0];
  if (best === undefined) return null;
  const tablePoints = halfSpicyPoints(best.cappedFaan);
  return {
    ...best,
    explanation: {
      awardedPatternIds: best.awardedPatterns.map((candidate) => candidate.id),
      suppressed: best.suppressedPatterns.map((candidate) => ({
        by: candidate.by,
        patternId: candidate.pattern.id,
        reason: candidate.reason,
      })),
    },
    payments: calculatePayments({
      tablePoints,
      winnerSeat: fixture.winnerSeat,
      winningTileSource: fixture.winningTileSource,
    }),
    tablePoints,
  };
}
