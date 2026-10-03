import { seat } from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import {
  awardPatterns,
  patternSuppressionGraph,
  validatePatternInteractionGraph,
} from "./award-patterns.js";
import { decomposeWinningHand } from "./decompose-hand.js";
import { detectPatterns } from "./detect-patterns.js";
import { createScoringHandFixture, scoringTileId } from "./hand-fixture.js";
import { calculatePayments, halfSpicyPoints } from "./payments.js";
import { scoreDecomposition, scoreHongKongHand } from "./score-hand.js";
import { scoringFixture } from "./scoring-test-fixtures.js";

function onlyDecomposition(
  fixture: ReturnType<typeof scoringFixture>,
): ReturnType<typeof decomposeWinningHand>[number] {
  const decomposition = decomposeWinningHand(fixture)[0];
  if (decomposition === undefined)
    throw new Error("Fixture did not decompose.");
  return decomposition;
}

describe("Hong Kong pattern awarding", () => {
  it("has an acyclic, self-suppression-free interaction graph", () => {
    expect(() => {
      validatePatternInteractionGraph();
    }).not.toThrow();
    expect(
      patternSuppressionGraph
        .map((edge) => `${edge.by}>${edge.suppresses}:${edge.reason}`)
        .sort(),
    ).toEqual(
      [
        "all-flowers>matching-flower:complete-family",
        "all-one-suit>mixed-one-suit:ordinary-exclusion",
        "all-seasons>matching-season:complete-family",
        "double-kong-win>replacement-win:specific-condition",
        "earthly-hand>double-kong-win:specific-condition",
        "earthly-hand>fully-concealed:specific-condition",
        "earthly-hand>last-catch:specific-condition",
        "earthly-hand>replacement-win:specific-condition",
        "earthly-hand>robbing-kong:specific-condition",
        "earthly-hand>self-pick:specific-condition",
        "four-concealed-triplets>fully-concealed:structure-specific",
        "great-dragons>green-dragon:dragon-total",
        "great-dragons>red-dragon:dragon-total",
        "great-dragons>white-dragon:dragon-total",
        "heavenly-hand>double-kong-win:specific-condition",
        "heavenly-hand>fully-concealed:specific-condition",
        "heavenly-hand>last-catch:specific-condition",
        "heavenly-hand>replacement-win:specific-condition",
        "heavenly-hand>robbing-kong:specific-condition",
        "heavenly-hand>self-pick:specific-condition",
        "nine-gates>fully-concealed:structure-specific",
        "seven-pairs>fully-concealed:structure-specific",
        "small-dragons>green-dragon:dragon-total",
        "small-dragons>red-dragon:dragon-total",
        "small-dragons>white-dragon:dragon-total",
        "thirteen-orphans>fully-concealed:structure-specific",
      ].sort(),
    );
    for (const edge of patternSuppressionGraph) {
      const awards = awardPatterns([
        { category: "hand", faan: 1, id: edge.by },
        { category: "hand", faan: 1, id: edge.suppresses },
      ]);
      expect(
        awards.suppressed.some(
          (candidate) =>
            candidate.by === edge.by &&
            candidate.pattern.id === edge.suppresses,
        ),
      ).toBe(true);
    }
  });

  it("suppresses individual dragons under Small Dragons", () => {
    const fixture = scoringFixture({
      concealed: "R R R G G G c1 c2 c3 c4 c5 c6 H H",
    });
    const decomposition = onlyDecomposition(fixture);
    const awards = awardPatterns(detectPatterns(fixture, decomposition));

    expect(awards.awarded.map((candidate) => candidate.id)).toContain(
      "small-dragons",
    );
    expect(awards.awarded.map((candidate) => candidate.id)).not.toContain(
      "red-dragon",
    );
    expect(
      awards.suppressed.some(
        (candidate) =>
          candidate.by === "small-dragons" &&
          candidate.pattern.id === "red-dragon",
      ),
    ).toBe(true);
    expect(
      awards.suppressed.some(
        (candidate) =>
          candidate.by === "small-dragons" &&
          candidate.pattern.id === "green-dragon",
      ),
    ).toBe(true);
  });

  it("suppresses all individual dragons under reachable Great Dragons", () => {
    const score = scoreHongKongHand(
      scoringFixture({
        concealed: "R R R G G G H H H c1 c2 c3 E E",
      }),
    );
    expect(score?.awardedPatterns.map((candidate) => candidate.id)).toContain(
      "great-dragons",
    );
    for (const id of ["green-dragon", "red-dragon", "white-dragon"] as const) {
      expect(
        score?.suppressedPatterns.some(
          (candidate) =>
            candidate.by === "great-dragons" && candidate.pattern.id === id,
        ),
      ).toBe(true);
    }
  });

  it("suppresses matching bonuses under their complete family", () => {
    const fixture = scoringFixture({
      bonuses: [136, 137, 138, 139, 140, 141, 142, 143],
      concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
    });
    const decomposition = onlyDecomposition(fixture);
    const awards = awardPatterns(detectPatterns(fixture, decomposition));
    expect(awards.awarded.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["all-flowers", "all-seasons"]),
    );
    expect(awards.awarded.map((candidate) => candidate.id)).not.toEqual(
      expect.arrayContaining(["matching-flower", "matching-season"]),
    );
  });

  it("selects only the highest limit and suppresses non-condition awards", () => {
    const fixture = scoringFixture({
      concealed: "E E E S S S W W W N N N R R",
      source: { type: "self-pick" },
    });
    const score = scoreHongKongHand(fixture);
    expect(score?.awardedPatterns.map((candidate) => candidate.id)).toEqual([
      "great-winds",
      "self-pick",
    ]);
    expect(score?.cappedFaan).toBe(13);
    for (const id of [
      "all-honors",
      "four-concealed-triplets",
      "no-bonuses",
    ] as const) {
      expect(
        score?.suppressedPatterns.some(
          (candidate) =>
            candidate.by === "great-winds" && candidate.pattern.id === id,
        ),
      ).toBe(true);
    }
  });

  it("uses canonical pattern ID to break equal-limit ties", () => {
    const fixture = scoringFixture({
      concealed: "R R",
      melds: ["E", "S", "W", "N"].map((token) => ({
        exposure: "concealed" as const,
        kind: "kong" as const,
        kongKind: "concealed" as const,
        tiles: `${token} ${token} ${token} ${token}`,
      })),
      source: { type: "self-pick" },
    });
    const score = scoreHongKongHand(fixture);
    expect(score?.detectedPatterns.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["four-kongs", "great-winds"]),
    );
    expect(score?.awardedPatterns.map((candidate) => candidate.id)).toEqual([
      "four-kongs",
      "self-pick",
    ]);
  });

  it("applies winning-condition suppressions deterministically", () => {
    const doubleKong = scoreHongKongHand(
      scoringFixture({
        concealed: "o1 o2 o3 b7 b8 b9 R R",
        conditions: { replacement: "double-kong" },
        melds: ["c1", "c9"].map((token) => ({
          exposure: "concealed" as const,
          kind: "kong" as const,
          kongKind: "concealed" as const,
          tiles: `${token} ${token} ${token} ${token}`,
        })),
        source: { type: "self-pick" },
      }),
    );
    expect(
      doubleKong?.awardedPatterns.map((candidate) => candidate.id),
    ).toContain("double-kong-win");
    expect(
      doubleKong?.awardedPatterns.map((candidate) => candidate.id),
    ).not.toContain("replacement-win");
    expect(
      doubleKong?.awardedPatterns.map((candidate) => candidate.id),
    ).toContain("self-pick");

    const heavenly = scoreHongKongHand(
      scoringFixture({
        bonuses: [136],
        concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        conditions: { opening: "heavenly", replacement: "bonus" },
        source: { type: "self-pick" },
        winner: seat("east"),
      }),
    );
    expect(
      heavenly?.awardedPatterns.map((candidate) => candidate.id),
    ).toContain("heavenly-hand");
    expect(
      heavenly?.awardedPatterns.map((candidate) => candidate.id),
    ).not.toEqual(
      expect.arrayContaining(["fully-concealed", "last-catch", "self-pick"]),
    );

    const earthly = scoreHongKongHand(
      scoringFixture({
        concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        conditions: { opening: "earthly" },
        source: { type: "discard", sourceSeat: seat("east") },
      }),
    );
    expect(earthly?.awardedPatterns.map((candidate) => candidate.id)).toContain(
      "earthly-hand",
    );
    expect(
      earthly?.suppressedPatterns.some(
        (candidate) =>
          candidate.by === "earthly-hand" &&
          candidate.pattern.id === "fully-concealed",
      ),
    ).toBe(true);
  });

  it.each([
    {
      concealed: "c1 c1 c2 c2 c3 c3 o4 o4 o5 o5 b6 b6 R R",
      suppressor: "seven-pairs",
    },
    {
      concealed: "c1 c1 c9 o1 o9 b1 b9 E S W N R G H",
      suppressor: "thirteen-orphans",
    },
    {
      concealed: "c1 c1 c1 c9 c9 c9 o2 o2 o2 E E E R R",
      source: { type: "self-pick" as const },
      suppressor: "four-concealed-triplets",
    },
    {
      concealed: "c1 c1 c1 c2 c3 c4 c5 c5 c6 c7 c8 c9 c9 c9",
      suppressor: "nine-gates",
    },
  ])("$suppressor suppresses generic Fully Concealed", (testCase) => {
    const score = scoreHongKongHand(scoringFixture(testCase));
    expect(score?.detectedPatterns.map((candidate) => candidate.id)).toContain(
      "fully-concealed",
    );
    expect(
      score?.awardedPatterns.map((candidate) => candidate.id),
    ).not.toContain("fully-concealed");
    expect(
      score?.suppressedPatterns.some(
        (candidate) =>
          candidate.by === testCase.suppressor &&
          candidate.pattern.id === "fully-concealed",
      ),
    ).toBe(true);
  });
});

describe("Hong Kong score selection and eligibility", () => {
  it("implements the documented Common Hand self-pick example", () => {
    const score = scoreHongKongHand(
      scoringFixture({
        concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        source: { type: "self-pick" },
        winner: seat("west"),
      }),
    );
    expect(score).toMatchObject({
      bonusFaan: 1,
      cappedFaan: 4,
      eligibilityFaan: 3,
      payments: { east: -8, north: -8, south: -8, west: 24 },
      rawFaan: 4,
      tablePoints: 16,
    });
  });

  it("does not let a matching bonus meet the three-faan minimum", () => {
    const score = scoreHongKongHand(
      scoringFixture({
        bonuses: [142],
        concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
      }),
    );
    expect(score).toBeNull();
  });

  it("chooses the highest-scoring interpretation of an ambiguous hand", () => {
    const score = scoreHongKongHand(
      scoringFixture({
        concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 R R",
        melds: [{ kind: "pung", tiles: "E E E" }],
      }),
    );
    expect(score?.decomposition.kind).toBe("standard");
    expect(
      score?.decomposition.kind === "standard"
        ? score.decomposition.melds.every((meld) => meld.kind === "pung")
        : false,
    ).toBe(true);
    expect(score?.awardedPatterns.map((candidate) => candidate.id)).toContain(
      "all-triplets",
    );
  });

  it("breaks a true capped-score decomposition tie by IDs then encoding", () => {
    const fixture = scoringFixture({
      concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 c4 c4 c4 c5 c5",
      conditions: { opening: "heavenly" },
      source: { type: "self-pick" },
      winner: seat("east"),
      winningToken: "c5",
    });
    const candidates = decomposeWinningHand(fixture).map((decomposition) =>
      scoreDecomposition(fixture, decomposition),
    );
    expect(candidates.length).toBeGreaterThan(1);
    expect(
      new Set(candidates.map((candidate) => candidate.cappedFaan)),
    ).toEqual(new Set([13]));
    expect(
      new Set(
        candidates.map((candidate) =>
          candidate.awardedPatterns.map((pattern) => pattern.id).join("|"),
        ),
      ).size,
    ).toBeGreaterThan(1);

    const selected = scoreHongKongHand(fixture);
    expect(selected?.awardedPatterns.map((candidate) => candidate.id)).toEqual([
      "all-one-suit",
      "heavenly-hand",
      "no-bonuses",
    ]);
    const sameAwardIds = candidates.filter(
      (candidate) =>
        candidate.awardedPatterns.map((pattern) => pattern.id).join("|") ===
        "all-one-suit|heavenly-hand|no-bonuses",
    );
    expect(sameAwardIds.length).toBeGreaterThan(1);
    expect(selected?.decomposition.encoding).toBe(
      sameAwardIds
        .map((candidate) => candidate.decomposition.encoding)
        .sort((left, right) => left.localeCompare(right))[0],
    );
  });

  it("caps raw faan at thirteen before conversion", () => {
    const score = scoreHongKongHand(
      scoringFixture({
        concealed: "E E E S S S W W W N N N R R",
        conditions: { wallPosition: "final-wall-tile" },
        source: { type: "self-pick" },
      }),
    );
    expect(score?.rawFaan).toBeGreaterThan(13);
    expect(score).toMatchObject({ cappedFaan: 13, tablePoints: 384 });
  });

  it("is stable under concealed-hand ordering", () => {
    const first = scoreHongKongHand(
      scoringFixture({
        concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 c4 c4 c4 c5 c5",
        winningToken: "c5",
      }),
    );
    const reversed = scoreHongKongHand(
      scoringFixture({
        concealed: "c5 c5 c4 c4 c4 c3 c3 c3 c2 c2 c2 c1 c1 c1",
        winningToken: "c5",
      }),
    );
    expect(reversed).toEqual(first);
  });

  it("preserves score semantics under equivalent physical-copy substitution", () => {
    const originalFixture = scoringFixture({
      concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
      source: { type: "self-pick" },
    });
    const originalC1 = scoringTileId(
      { type: "suited", suit: "characters", rank: 1 },
      0,
    );
    const replacementC1 = scoringTileId(
      { type: "suited", suit: "characters", rank: 1 },
      3,
    );
    const substitutedFixture = createScoringHandFixture({
      ...originalFixture,
      concealedTileIds: originalFixture.concealedTileIds.map((id) =>
        id === originalC1 ? replacementC1 : id,
      ),
    });
    const original = scoreHongKongHand(originalFixture);
    const substituted = scoreHongKongHand(substitutedFixture);
    expect(substituted?.awardedPatterns).toEqual(original?.awardedPatterns);
    expect(substituted?.cappedFaan).toBe(original?.cappedFaan);
    expect(substituted?.payments).toEqual(original?.payments);
    expect(substituted?.tablePoints).toBe(original?.tablePoints);
  });

  it("rotates wind awards without changing score semantics", () => {
    const east = scoreHongKongHand(
      scoringFixture({
        concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 R R",
        melds: [{ kind: "pung", tiles: "E E E" }],
        prevailingWind: seat("east"),
        winner: seat("east"),
      }),
    );
    const south = scoreHongKongHand(
      scoringFixture({
        concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 R R",
        melds: [{ kind: "pung", tiles: "S S S" }],
        prevailingWind: seat("south"),
        source: { type: "discard", sourceSeat: seat("west") },
        winner: seat("south"),
      }),
    );
    expect(south?.awardedPatterns).toEqual(east?.awardedPatterns);
    expect(south?.cappedFaan).toBe(east?.cappedFaan);
    expect(east?.payments).toEqual({ east: 96, north: 0, south: -96, west: 0 });
    expect(south?.payments).toEqual({
      east: 0,
      north: 0,
      south: 96,
      west: -96,
    });
  });
});

describe("Half Spicy conversion and zero-sum payments", () => {
  it.each([
    [3, 8],
    [4, 16],
    [5, 24],
    [6, 32],
    [7, 48],
    [8, 64],
    [9, 96],
    [10, 128],
    [11, 192],
    [12, 256],
    [13, 384],
  ])("maps %i faan to %i points", (faan, points) => {
    expect(halfSpicyPoints(faan)).toBe(points);
  });

  it("charges only the source on discard and robbing wins", () => {
    expect(
      calculatePayments({
        tablePoints: 32,
        winnerSeat: seat("north"),
        winningTileSource: { type: "discard", sourceSeat: seat("south") },
      }),
    ).toEqual({ east: 0, north: 32, south: -32, west: 0 });
    expect(
      calculatePayments({
        tablePoints: 32,
        winnerSeat: seat("north"),
        winningTileSource: { type: "robbing-kong", sourceSeat: seat("south") },
      }),
    ).toEqual({ east: 0, north: 32, south: -32, west: 0 });
  });

  it.each(["east", "south", "west", "north"] as const)(
    "rotates self-pick payments with a %s winner and no dealer multiplier",
    (winner) => {
      const payments = calculatePayments({
        tablePoints: 24,
        winnerSeat: seat(winner),
        winningTileSource: { type: "self-pick" },
      });
      expect(
        payments.east + payments.south + payments.west + payments.north,
      ).toBe(0);
      expect(payments[winner]).toBe(36);
      expect(
        Object.values(payments).filter((value) => value === -12),
      ).toHaveLength(3);
    },
  );
});
