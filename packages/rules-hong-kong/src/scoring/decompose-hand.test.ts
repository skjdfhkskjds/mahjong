import { seat } from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import { decomposeWinningHand } from "./decompose-hand.js";
import { createScoringHandFixture, scoringTileId } from "./hand-fixture.js";
import { scoringFixture } from "./scoring-test-fixtures.js";

describe("Hong Kong winning-hand decomposition", () => {
  it("enumerates every standard kind interpretation in canonical order", () => {
    const fixture = scoringFixture({
      concealed: "c1 c1 c1 c2 c2 c2 c3 c3 c3 c4 c4 c4 c5 c5",
    });

    const decompositions = decomposeWinningHand(fixture);
    expect(decompositions.map((candidate) => candidate.encoding)).toEqual(
      [...decompositions]
        .map((candidate) => candidate.encoding)
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(
      decompositions.filter((candidate) => candidate.kind === "standard")
        .length,
    ).toBeGreaterThan(1);
    expect(
      decompositions.some(
        (candidate) =>
          candidate.kind === "standard" &&
          candidate.melds.every((meld) => meld.kind === "pung"),
      ),
    ).toBe(true);
    const allPungs = decompositions.find(
      (candidate) =>
        candidate.kind === "standard" &&
        candidate.melds.every((meld) => meld.kind === "pung"),
    );
    expect(allPungs?.kind).toBe("standard");
    if (allPungs?.kind !== "standard") {
      throw new Error("Expected the exact all-pung decomposition.");
    }
    expect(allPungs.pair).toEqual([16, 17]);
    expect(allPungs.melds.map((meld) => meld.tileIds)).toEqual([
      [0, 1, 2],
      [4, 5, 6],
      [8, 9, 10],
      [12, 13, 14],
    ]);
    expect(
      decompositions.some(
        (candidate) =>
          candidate.kind === "standard" &&
          candidate.melds.some((meld) => meld.kind === "chow"),
      ),
    ).toBe(true);
  });

  it("recognizes exactly seven distinct two-copy kinds", () => {
    const valid = scoringFixture({
      concealed: "c1 c1 c2 c2 c3 c3 o4 o4 o5 o5 b6 b6 R R",
    });
    expect(
      decomposeWinningHand(valid).map((candidate) => candidate.kind),
    ).toContain("seven-pairs");

    const fourCopyKind = scoringFixture({
      concealed: "c1 c1 c1 c1 c2 c2 c3 c3 o4 o4 b6 b6 R R",
    });
    expect(
      decomposeWinningHand(fourCopyKind).map((candidate) => candidate.kind),
    ).not.toContain("seven-pairs");

    const withDeclaredMeld = scoringFixture({
      concealed: "c1 c1 c2 c2 c3 c3 o4 o4 o5 o5 R",
      melds: [{ kind: "pung", tiles: "b6 b6 b6" }],
    });
    expect(
      decomposeWinningHand(withDeclaredMeld).map((candidate) => candidate.kind),
    ).not.toContain("seven-pairs");
  });

  it("recognizes Thirteen Orphans and rejects a one-tile near miss", () => {
    const valid = scoringFixture({
      concealed: "c1 c1 c9 o1 o9 b1 b9 E S W N R G H",
    });
    expect(
      decomposeWinningHand(valid).map((candidate) => candidate.kind),
    ).toContain("thirteen-orphans");

    const nearMiss = scoringFixture({
      concealed: "c1 c1 c8 o1 o9 b1 b9 E S W N R G H",
    });
    expect(
      decomposeWinningHand(nearMiss).map((candidate) => candidate.kind),
    ).not.toContain("thirteen-orphans");
  });

  it("rejects structurally invalid physical fixtures before decomposition", () => {
    const repeated = scoringTileId(
      { type: "suited", suit: "characters", rank: 1 },
      0,
    );
    expect(() =>
      createScoringHandFixture({
        concealedTileIds: Array.from({ length: 14 }, () => repeated),
        prevailingWind: seat("east"),
        winnerSeat: seat("east"),
        winningTileId: repeated,
        winningTileSource: { type: "self-pick" },
      }),
    ).toThrow("only once");
  });

  it("strictly rejects malformed meld, size, and scoring provenance fixtures", () => {
    expect(() =>
      scoringFixture({
        concealed: "c5 c5 c5 c6 c6 c6 c7 c7 c7 R R",
        melds: [{ kind: "chow", tiles: "c1 c2 c4" }],
      }),
    ).toThrow("consecutive ranks");
    expect(() =>
      scoringFixture({
        concealed: "c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        melds: [{ exposure: "concealed", kind: "pung", tiles: "c1 c1 c1" }],
      }),
    ).toThrow("Only a declared concealed kong");
    expect(() =>
      scoringFixture({ concealed: "c1 c2 c3 c4 c5 c6 c7 c8 c9 E E E R" }),
    ).toThrow("fourteen structural tile slots");
    expect(() =>
      scoringFixture({
        concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        conditions: { replacement: "kong" },
        source: { type: "self-pick" },
      }),
    ).toThrow("requires a declared kong");
    expect(() =>
      scoringFixture({
        concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        conditions: { wallPosition: "final-wall-tile" },
      }),
    ).toThrow("must be self-picked");
    expect(() =>
      scoringFixture({
        concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        source: { type: "discard", sourceSeat: seat("west") },
      }),
    ).toThrow("cannot also be the winner");

    const exposed = scoringFixture({
      concealed: "c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
      melds: [{ kind: "chow", tiles: "c1 c2 c3" }],
    });
    const exposedMeld = exposed.declaredMelds[0];
    if (exposedMeld?.claimedTileId === undefined) {
      throw new Error("Fixture exposed meld provenance is absent.");
    }
    expect(exposedMeld.exposure).toBe("exposed");
    expect(exposedMeld.sourceSeat).toBe(seat("south"));
    expect(exposedMeld.tileIds).toContain(exposedMeld.claimedTileId);
    expect(() =>
      scoringFixture({
        concealed: "c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        melds: [
          {
            kind: "chow",
            sourceSeat: seat("north"),
            tiles: "c1 c2 c3",
          },
        ],
      }),
    ).toThrow("source provenance is impossible");
    expect(() =>
      createScoringHandFixture({
        ...exposed,
        declaredMelds: exposed.declaredMelds.map((meld) => ({
          exposure: meld.exposure,
          id: meld.id,
          kind: meld.kind,
          tileIds: meld.tileIds,
        })),
      }),
    ).toThrow("Every exposed meld");
    expect(() =>
      createScoringHandFixture({
        ...exposed,
        declaredMelds: [{ ...exposedMeld, sourceSeat: exposed.winnerSeat }],
      }),
    ).toThrow("source provenance is impossible");
    expect(() =>
      createScoringHandFixture({
        ...exposed,
        declaredMelds: [{ ...exposedMeld, id: "" }],
      }),
    ).toThrow("meld ID cannot be empty");

    const concealedKong = scoringFixture({
      concealed: "c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
      melds: [
        {
          exposure: "concealed",
          kind: "kong",
          kongKind: "concealed",
          tiles: "c1 c1 c1 c1",
        },
      ],
    });
    const kong = concealedKong.declaredMelds[0];
    const forgedClaimedTileId = kong?.tileIds[0];
    if (kong === undefined || forgedClaimedTileId === undefined)
      throw new Error("Fixture concealed kong is absent.");
    expect(() =>
      createScoringHandFixture({
        ...concealedKong,
        declaredMelds: [
          {
            ...kong,
            claimedTileId: forgedClaimedTileId,
            sourceSeat: seat("east"),
          },
        ],
      }),
    ).toThrow("cannot carry claim provenance");
  });

  it("rejects impossible opening, wall, and replacement cross-products", () => {
    const concealed = "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R";
    expect(() =>
      scoringFixture({
        concealed,
        conditions: { replacement: "bonus" },
        source: { type: "self-pick" },
      }),
    ).toThrow("requires an exposed bonus");
    expect(() =>
      scoringFixture({
        concealed,
        conditions: { opening: "heavenly", wallPosition: "final-wall-tile" },
        source: { type: "self-pick" },
        winner: seat("east"),
      }),
    ).toThrow("cannot also be Last Catch");
    expect(() =>
      scoringFixture({
        concealed: "c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        conditions: { opening: "heavenly" },
        melds: [{ kind: "chow", tiles: "c1 c2 c3" }],
        source: { type: "self-pick" },
        winner: seat("east"),
      }),
    ).toThrow("declared meld disqualifies");
    expect(() =>
      scoringFixture({
        concealed,
        conditions: {
          opening: "earthly",
          wallPosition: "discard-after-final-wall-tile",
        },
        source: { type: "discard", sourceSeat: seat("east") },
      }),
    ).toThrow("Earthly Hand cannot follow");
    expect(() =>
      scoringFixture({
        bonuses: [136],
        concealed,
        conditions: { opening: "earthly", replacement: "bonus" },
        source: { type: "discard", sourceSeat: seat("east") },
      }),
    ).toThrow("replacement win must be self-picked");
    expect(() =>
      scoringFixture({
        concealed,
        conditions: { opening: "earthly" },
        source: { type: "self-pick" },
      }),
    ).toThrow("requires a non-East seat");
    expect(() =>
      scoringFixture({
        concealed,
        conditions: { wallPosition: "discard-after-final-wall-tile" },
        source: { type: "robbing-kong", sourceSeat: seat("east") },
      }),
    ).toThrow("requires the following discard");
    expect(() =>
      scoringFixture({
        bonuses: [136],
        concealed,
        conditions: { replacement: "bonus" },
      }),
    ).toThrow("replacement win must be self-picked");
    expect(() =>
      scoringFixture({
        concealed: "o1 o2 o3 b7 b8 b9 R R",
        conditions: { opening: "heavenly", replacement: "double-kong" },
        melds: ["c1", "c9"].map((token) => ({
          exposure: "concealed" as const,
          kind: "kong" as const,
          kongKind: "concealed" as const,
          tiles: `${token} ${token} ${token} ${token}`,
        })),
        source: { type: "self-pick" },
        winner: seat("east"),
      }),
    ).toThrow("kong disqualifies Heavenly Hand");
    expect(() =>
      scoringFixture({
        concealed: "c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
        conditions: { opening: "earthly" },
        melds: [{ kind: "chow", tiles: "c1 c2 c3" }],
        source: { type: "discard", sourceSeat: seat("east") },
      }),
    ).toThrow("Earthly Hand cannot follow");
    expect(() =>
      scoringFixture({
        bonuses: [136],
        concealed,
        conditions: { opening: "heavenly", replacement: "bonus" },
        source: { type: "self-pick" },
        winner: seat("east"),
      }),
    ).not.toThrow();
  });
});
