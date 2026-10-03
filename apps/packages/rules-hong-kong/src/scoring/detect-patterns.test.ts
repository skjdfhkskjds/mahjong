import { seat } from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import { decomposeWinningHand } from "./decompose-hand.js";
import type { PatternId } from "./detect-patterns.js";
import { detectPatterns, patternCatalog } from "./detect-patterns.js";
import type { FixtureSpec } from "./scoring-test-fixtures.js";
import { scoringFixture } from "./scoring-test-fixtures.js";

function detectedIds(spec: FixtureSpec): ReadonlySet<PatternId> {
  const fixture = scoringFixture(spec);
  return new Set(
    decomposeWinningHand(fixture).flatMap((decomposition) =>
      detectPatterns(fixture, decomposition).map((candidate) => candidate.id),
    ),
  );
}

const standardPatternCases: readonly {
  readonly id: PatternId;
  readonly nearMiss: FixtureSpec;
  readonly positive: FixtureSpec;
}[] = [
  {
    id: "common-hand",
    positive: {
      concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
    },
    nearMiss: {
      concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b7 b7 R R",
    },
  },
  {
    id: "all-triplets",
    positive: { concealed: "c1 c1 c1 c9 c9 c9 o2 o2 o2 E E E R R" },
    nearMiss: { concealed: "c1 c2 c3 c9 c9 c9 o2 o2 o2 E E E R R" },
  },
  {
    id: "mixed-one-suit",
    positive: { concealed: "c1 c2 c3 c4 c5 c6 c7 c8 c9 E E E R R" },
    nearMiss: { concealed: "c1 c2 c3 c4 c5 c6 c7 c8 c9 c1 c1 c1 c2 c2" },
  },
  {
    id: "all-one-suit",
    positive: { concealed: "c1 c2 c3 c4 c5 c6 c7 c8 c9 c1 c1 c1 c2 c2" },
    nearMiss: { concealed: "c1 c2 c3 c4 c5 c6 c7 c8 c9 E E E c2 c2" },
  },
  {
    id: "mixed-orphans",
    positive: { concealed: "c1 c1 c1 c9 c9 c9 o1 o1 o1 E E E R R" },
    nearMiss: { concealed: "c1 c1 c1 c9 c9 c9 o8 o8 o8 E E E R R" },
  },
  {
    id: "small-dragons",
    positive: { concealed: "R R R G G G c1 c2 c3 c4 c5 c6 H H" },
    nearMiss: { concealed: "R R R c7 c7 c7 c1 c2 c3 c4 c5 c6 H H" },
  },
  {
    id: "great-dragons",
    positive: { concealed: "R R R G G G H H H c1 c2 c3 E E" },
    nearMiss: { concealed: "R R R G G G c7 c7 c7 c1 c2 c3 E E" },
  },
  {
    id: "small-winds",
    positive: { concealed: "E E E S S S W W W c1 c2 c3 N N" },
    nearMiss: { concealed: "E E E S S S R R R c1 c2 c3 N N" },
  },
  {
    id: "seven-pairs",
    positive: { concealed: "c1 c1 c2 c2 c3 c3 o4 o4 o5 o5 b6 b6 R R" },
    nearMiss: { concealed: "c1 c1 c1 c1 c2 c2 c3 c3 o4 o4 b6 b6 R R" },
  },
  {
    id: "all-honors",
    positive: { concealed: "E E E S S S R R R G G G H H" },
    nearMiss: { concealed: "c1 c1 c1 S S S R R R G G G H H" },
  },
  {
    id: "four-concealed-triplets",
    positive: {
      concealed: "c1 c1 c1 c9 c9 c9 o2 o2 o2 E E E R R",
      source: { type: "self-pick" },
    },
    nearMiss: {
      concealed: "c1 c1 c1 c9 c9 c9 o2 o2 o2 E E E R R",
      winningToken: "E",
    },
  },
  {
    id: "terminals-only",
    positive: { concealed: "c1 c1 c1 c9 c9 c9 o1 o1 o1 b9 b9 b9 o9 o9" },
    nearMiss: { concealed: "c1 c1 c1 c9 c9 c9 o1 o1 o1 b8 b8 b8 o9 o9" },
  },
  {
    id: "nine-gates",
    positive: { concealed: "c1 c1 c1 c2 c3 c4 c5 c5 c6 c7 c8 c9 c9 c9" },
    nearMiss: { concealed: "c1 c2 c3 c4 c5 c6 c7 c8 c9 c2 c2 c2 c5 c5" },
  },
  {
    id: "great-winds",
    positive: { concealed: "E E E S S S W W W N N N R R" },
    nearMiss: { concealed: "E E E S S S W W W G G G R R" },
  },
  {
    id: "thirteen-orphans",
    positive: { concealed: "c1 c1 c9 o1 o9 b1 b9 E S W N R G H" },
    nearMiss: { concealed: "c1 c1 c8 o1 o9 b1 b9 E S W N R G H" },
  },
];

describe("Hong Kong scoring pattern detection", () => {
  it("matches the independently frozen catalog IDs, categories, and faan", () => {
    expect(patternCatalog).toEqual({
      "all-honors": { category: "limit", faan: 10 },
      "all-one-suit": { category: "hand", faan: 7 },
      "all-seasons": { category: "bonus", faan: 2 },
      "all-flowers": { category: "bonus", faan: 2 },
      "all-triplets": { category: "hand", faan: 3 },
      "common-hand": { category: "hand", faan: 1 },
      "double-kong-win": { category: "winning-condition", faan: 8 },
      "earthly-hand": { category: "winning-condition", faan: 13 },
      "four-concealed-triplets": { category: "limit", faan: 10 },
      "four-kongs": { category: "limit", faan: 13 },
      "fully-concealed": { category: "winning-condition", faan: 1 },
      "great-dragons": { category: "hand", faan: 8 },
      "great-winds": { category: "limit", faan: 13 },
      "green-dragon": { category: "value-honor", faan: 1 },
      "heavenly-hand": { category: "winning-condition", faan: 13 },
      "last-catch": { category: "winning-condition", faan: 1 },
      "matching-flower": { category: "bonus", faan: 1 },
      "matching-season": { category: "bonus", faan: 1 },
      "mixed-one-suit": { category: "hand", faan: 3 },
      "mixed-orphans": { category: "hand", faan: 1 },
      "nine-gates": { category: "limit", faan: 10 },
      "no-bonuses": { category: "bonus", faan: 1 },
      "prevailing-wind": { category: "value-honor", faan: 1 },
      "red-dragon": { category: "value-honor", faan: 1 },
      "replacement-win": { category: "winning-condition", faan: 1 },
      "robbing-kong": { category: "winning-condition", faan: 1 },
      "seat-wind": { category: "value-honor", faan: 1 },
      "self-pick": { category: "winning-condition", faan: 1 },
      "seven-pairs": { category: "hand", faan: 4 },
      "small-dragons": { category: "hand", faan: 5 },
      "small-winds": { category: "hand", faan: 6 },
      "terminals-only": { category: "limit", faan: 10 },
      "thirteen-orphans": { category: "limit", faan: 13 },
      "white-dragon": { category: "value-honor", faan: 1 },
    });
  });

  it.each(standardPatternCases)(
    "detects $id and rejects its near miss",
    ({ id, positive, nearMiss }) => {
      expect(detectedIds(positive)).toContain(id);
      expect(detectedIds(nearMiss)).not.toContain(id);
    },
  );

  it("uses a valid winning hand for the Nine Gates near miss", () => {
    const fixture = scoringFixture({
      concealed: "c1 c2 c3 c4 c5 c6 c7 c8 c9 c2 c2 c2 c5 c5",
    });
    const decompositions = decomposeWinningHand(fixture);
    expect(decompositions.length).toBeGreaterThan(0);
    expect(
      decompositions.flatMap((decomposition) =>
        detectPatterns(fixture, decomposition).map((candidate) => candidate.id),
      ),
    ).not.toContain("nine-gates");
  });

  it("detects Four Kongs only when all four melds are declared kongs", () => {
    const positive: FixtureSpec = {
      concealed: "R R",
      melds: ["c1", "c9", "o1", "o9"].map((token) => ({
        exposure: "concealed",
        kind: "kong" as const,
        kongKind: "concealed" as const,
        tiles: `${token} ${token} ${token} ${token}`,
      })),
      source: { type: "self-pick" },
    };
    const nearMiss: FixtureSpec = {
      ...positive,
      concealed: "b1 b1 b1 R R",
      melds: positive.melds?.slice(0, 3) ?? [],
    };
    expect(detectedIds(positive)).toContain("four-kongs");
    expect(detectedIds(nearMiss)).not.toContain("four-kongs");
  });

  it("enforces every Four Concealed Triplets exposure and winning-tile boundary", () => {
    const concealed = "c9 c9 c9 o2 o2 o2 E E E R R";
    const concealedKong = {
      exposure: "concealed" as const,
      kind: "kong" as const,
      kongKind: "concealed" as const,
      tiles: "c1 c1 c1 c1",
    };
    expect(
      detectedIds({
        concealed,
        melds: [concealedKong],
        winningToken: "R",
      }),
    ).toContain("four-concealed-triplets");
    expect(
      detectedIds({
        concealed,
        melds: [concealedKong],
        winningToken: "E",
      }),
    ).not.toContain("four-concealed-triplets");
    for (const kongKind of ["exposed", "added"] as const) {
      const ids = detectedIds({
        concealed,
        melds: [
          {
            exposure: "exposed",
            kind: "kong",
            kongKind,
            tiles: "c1 c1 c1 c1",
          },
        ],
        winningToken: "R",
      });
      expect(ids).not.toContain("four-concealed-triplets");
      expect(ids).not.toContain("fully-concealed");
    }
  });

  it.each([
    {
      id: "seat-wind" as const,
      positive: { winner: seat("west") },
      negative: { winner: seat("north") },
      tiles: "W W W c1 c1 c1 c2 c2 c2 c3 c3 c3 R R",
    },
    {
      id: "prevailing-wind" as const,
      positive: { prevailingWind: seat("east") },
      negative: { prevailingWind: seat("north") },
      tiles: "E E E c1 c1 c1 c2 c2 c2 c3 c3 c3 R R",
    },
    {
      id: "red-dragon" as const,
      positive: {},
      negative: {},
      tiles: "R R R c1 c1 c1 c2 c2 c2 c3 c3 c3 E E",
      nearTiles: "G G G c1 c1 c1 c2 c2 c2 c3 c3 c3 E E",
    },
    {
      id: "green-dragon" as const,
      positive: {},
      negative: {},
      tiles: "G G G c1 c1 c1 c2 c2 c2 c3 c3 c3 E E",
      nearTiles: "H H H c1 c1 c1 c2 c2 c2 c3 c3 c3 E E",
    },
    {
      id: "white-dragon" as const,
      positive: {},
      negative: {},
      tiles: "H H H c1 c1 c1 c2 c2 c2 c3 c3 c3 E E",
      nearTiles: "R R R c1 c1 c1 c2 c2 c2 c3 c3 c3 E E",
    },
  ])("detects $id and rejects its near miss", (testCase) => {
    expect(
      detectedIds({ concealed: testCase.tiles, ...testCase.positive }),
    ).toContain(testCase.id);
    expect(
      detectedIds({
        concealed: testCase.nearTiles ?? testCase.tiles,
        ...testCase.negative,
      }),
    ).not.toContain(testCase.id);
  });

  it.each([
    { id: "no-bonuses" as const, positive: [], negative: [136] },
    { id: "matching-season" as const, positive: [138], negative: [136] },
    { id: "matching-flower" as const, positive: [142], negative: [140] },
    {
      id: "all-seasons" as const,
      positive: [136, 137, 138, 139],
      negative: [136, 137, 138],
    },
    {
      id: "all-flowers" as const,
      positive: [140, 141, 142, 143],
      negative: [140, 141, 142],
    },
  ])("detects $id and rejects its near miss", ({ id, positive, negative }) => {
    const concealed = "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R";
    expect(detectedIds({ bonuses: positive, concealed })).toContain(id);
    expect(detectedIds({ bonuses: negative, concealed })).not.toContain(id);
  });

  it.each([
    {
      id: "self-pick" as const,
      positive: { source: { type: "self-pick" as const } },
      negative: {},
    },
    {
      id: "fully-concealed" as const,
      positive: {},
      negative: {
        concealed: "c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        melds: [{ kind: "chow" as const, tiles: "c1 c2 c3" }],
      },
    },
    {
      id: "robbing-kong" as const,
      positive: {
        source: { type: "robbing-kong" as const, sourceSeat: seat("south") },
      },
      negative: {},
    },
    {
      id: "last-catch" as const,
      positive: {
        conditions: { wallPosition: "final-wall-tile" as const },
        source: { type: "self-pick" as const },
      },
      negative: {},
    },
    {
      id: "replacement-win" as const,
      positive: {
        bonuses: [136],
        conditions: { replacement: "bonus" as const },
        source: { type: "self-pick" as const },
      },
      negative: { source: { type: "self-pick" as const } },
    },
    {
      id: "double-kong-win" as const,
      positive: {
        concealed: "o1 o2 o3 b7 b8 b9 R R",
        conditions: { replacement: "double-kong" as const },
        melds: ["c1", "c9"].map((token) => ({
          exposure: "concealed" as const,
          kind: "kong" as const,
          kongKind: "concealed" as const,
          tiles: `${token} ${token} ${token} ${token}`,
        })),
        source: { type: "self-pick" as const },
      },
      negative: {
        concealed: "c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        conditions: { replacement: "kong" as const },
        melds: [
          {
            exposure: "concealed" as const,
            kind: "kong" as const,
            kongKind: "concealed" as const,
            tiles: "c1 c1 c1 c1",
          },
        ],
        source: { type: "self-pick" as const },
      },
    },
    {
      id: "heavenly-hand" as const,
      positive: {
        conditions: { opening: "heavenly" as const },
        source: { type: "self-pick" as const },
        winner: seat("east"),
      },
      negative: {
        source: { type: "self-pick" as const },
        winner: seat("east"),
      },
    },
    {
      id: "earthly-hand" as const,
      positive: {
        conditions: { opening: "earthly" as const },
        source: { type: "discard" as const, sourceSeat: seat("east") },
      },
      negative: {
        source: { type: "discard" as const, sourceSeat: seat("east") },
      },
    },
  ])("detects $id and rejects its near miss", ({ id, positive, negative }) => {
    const base = {
      concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
    };
    expect(detectedIds({ ...base, ...positive })).toContain(id);
    expect(detectedIds({ ...base, ...negative })).not.toContain(id);
  });
});
