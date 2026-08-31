import { describe, expect, it } from "vitest";

import { createHongKongV1TileSet } from "./create-tile-set.js";
import {
  deterministicShuffle,
  HONG_KONG_V1_RANDOM_BYTES,
  HONG_KONG_V1_SHUFFLE_ALGORITHM,
  selectInitialDealerPosition,
} from "./deterministic-shuffle.js";

function randomness(offset: number): Uint8Array {
  return Uint8Array.from(
    { length: HONG_KONG_V1_RANDOM_BYTES },
    (_, index) => (index * 73 + offset) & 0xff,
  );
}

describe("hong-kong/v1 deterministic shuffle", () => {
  it("publishes the versioned byte-stream algorithm and fixed vector", () => {
    expect(HONG_KONG_V1_SHUFFLE_ALGORITHM).toBe(
      "random-bytes-rejection-fisher-yates/v1",
    );
    expect(
      deterministicShuffle(createHongKongV1TileSet(), randomness(1)).map(
        ({ id }) => id,
      ),
    ).toEqual([
      52, 3, 74, 14, 10, 128, 40, 48, 84, 46, 34, 97, 6, 20, 56, 98, 82, 11, 18,
      126, 129, 64, 88, 35, 104, 93, 16, 58, 8, 99, 36, 65, 118, 80, 30, 47, 4,
      139, 44, 105, 78, 110, 70, 141, 76, 19, 54, 66, 87, 62, 2, 83, 50, 106, 7,
      114, 51, 67, 42, 72, 117, 41, 60, 95, 57, 96, 63, 103, 43, 15, 127, 86,
      71, 113, 28, 89, 26, 75, 32, 107, 123, 49, 24, 131, 38, 102, 79, 112, 12,
      120, 27, 124, 111, 55, 59, 108, 94, 116, 109, 17, 143, 31, 5, 121, 142,
      13, 1, 85, 132, 138, 90, 119, 45, 134, 100, 29, 73, 39, 92, 53, 91, 122,
      115, 137, 81, 33, 130, 135, 22, 69, 68, 133, 37, 9, 77, 101, 140, 61, 136,
      125, 23, 25, 0, 21,
    ]);
    expect(selectInitialDealerPosition(randomness(1))).toBe(1);
  });

  it("is deterministic, byte-sensitive, and remains a permutation", () => {
    const tiles = createHongKongV1TileSet();
    const first = deterministicShuffle(tiles, randomness(10)).map(
      ({ id }) => id,
    );
    expect(
      deterministicShuffle(tiles, randomness(10)).map(({ id }) => id),
    ).toEqual(first);
    expect(
      deterministicShuffle(tiles, randomness(11)).map(({ id }) => id),
    ).not.toEqual(first);
    expect([...first].sort((left, right) => left - right)).toEqual(
      tiles.map(({ id }) => id),
    );
  });

  it("rejects insufficient random bytes", () => {
    expect(() =>
      deterministicShuffle(createHongKongV1TileSet(), new Uint8Array(1_027)),
    ).toThrow("at least 1028");
  });
});
