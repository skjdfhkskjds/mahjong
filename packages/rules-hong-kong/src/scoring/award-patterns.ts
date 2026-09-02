import type { DetectedPattern, PatternId } from "./detect-patterns.js";

export interface SuppressedPattern {
  readonly by: PatternId;
  readonly pattern: DetectedPattern;
  readonly reason:
    | "complete-family"
    | "dragon-total"
    | "limit-supersession"
    | "ordinary-exclusion"
    | "specific-condition"
    | "structure-specific";
}

export interface PatternAwards {
  readonly awarded: readonly DetectedPattern[];
  readonly suppressed: readonly SuppressedPattern[];
}

export interface PatternSuppressionEdge {
  readonly by: PatternId;
  readonly reason: SuppressedPattern["reason"];
  readonly suppresses: PatternId;
}

export const patternSuppressionGraph: readonly PatternSuppressionEdge[] = [
  {
    by: "all-flowers",
    reason: "complete-family",
    suppresses: "matching-flower",
  },
  {
    by: "all-one-suit",
    reason: "ordinary-exclusion",
    suppresses: "mixed-one-suit",
  },
  {
    by: "all-seasons",
    reason: "complete-family",
    suppresses: "matching-season",
  },
  ...(["green-dragon", "red-dragon", "white-dragon"] as const).flatMap(
    (suppresses): readonly PatternSuppressionEdge[] => [
      { by: "great-dragons", reason: "dragon-total", suppresses },
      { by: "small-dragons", reason: "dragon-total", suppresses },
    ],
  ),
  ...(
    [
      "double-kong-win",
      "fully-concealed",
      "last-catch",
      "replacement-win",
      "robbing-kong",
      "self-pick",
    ] as const
  ).flatMap((suppresses): readonly PatternSuppressionEdge[] => [
    { by: "earthly-hand", reason: "specific-condition", suppresses },
    { by: "heavenly-hand", reason: "specific-condition", suppresses },
  ]),
  {
    by: "double-kong-win",
    reason: "specific-condition",
    suppresses: "replacement-win",
  },
  ...(
    [
      "four-concealed-triplets",
      "nine-gates",
      "seven-pairs",
      "thirteen-orphans",
    ] as const
  ).map((by): PatternSuppressionEdge => ({
    by,
    reason: "structure-specific",
    suppresses: "fully-concealed",
  })),
];

export function validatePatternInteractionGraph(): void {
  const adjacency = new Map<PatternId, PatternId[]>();
  for (const edge of patternSuppressionGraph) {
    if (edge.by === edge.suppresses) {
      throw new Error("A pattern cannot suppress itself.");
    }
    const targets = adjacency.get(edge.by) ?? [];
    targets.push(edge.suppresses);
    adjacency.set(edge.by, targets);
  }
  const visiting = new Set<PatternId>();
  const visited = new Set<PatternId>();
  function visit(id: PatternId): void {
    if (visiting.has(id)) {
      throw new Error("Pattern suppression graph must be acyclic.");
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const suppressed of adjacency.get(id) ?? []) visit(suppressed);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of adjacency.keys()) visit(id);
}

function byId(
  patterns: readonly DetectedPattern[],
): ReadonlyMap<PatternId, DetectedPattern> {
  return new Map(patterns.map((pattern) => [pattern.id, pattern]));
}

export function awardPatterns(
  detected: readonly DetectedPattern[],
): PatternAwards {
  const patterns = byId(detected);
  const awarded = new Map(patterns);
  const suppressed: SuppressedPattern[] = [];

  function suppress(
    id: PatternId,
    by: PatternId,
    reason: SuppressedPattern["reason"],
  ): void {
    const candidate = awarded.get(id);
    if (candidate === undefined) return;
    awarded.delete(id);
    suppressed.push({ by, pattern: candidate, reason });
  }

  const opening = patterns.has("heavenly-hand") || patterns.has("earthly-hand");
  for (const edge of patternSuppressionGraph) {
    if (!patterns.has(edge.by)) continue;
    if (opening && edge.by === "double-kong-win") continue;
    suppress(edge.suppresses, edge.by, edge.reason);
  }

  const limits = detected
    .filter((candidate) => candidate.category === "limit")
    .sort(
      (left, right) =>
        right.faan - left.faan || left.id.localeCompare(right.id),
    );
  const selectedLimit = limits[0];
  if (selectedLimit !== undefined) {
    for (const candidate of [...awarded.values()]) {
      if (
        candidate.id !== selectedLimit.id &&
        candidate.category !== "winning-condition"
      ) {
        suppress(candidate.id, selectedLimit.id, "limit-supersession");
      }
    }
  }

  return {
    awarded: [...awarded.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    suppressed: suppressed.sort(
      (left, right) =>
        left.pattern.id.localeCompare(right.pattern.id) ||
        left.by.localeCompare(right.by),
    ),
  };
}
