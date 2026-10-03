import { describe, expect, it } from "vitest";

import { createHongKongV1TileSet } from "./create-tile-set.js";

describe("hong-kong/v1 tile inventory", () => {
  const tiles = createHongKongV1TileSet();

  it("contains 144 unique physical tiles", () => {
    expect(tiles).toHaveLength(144);
    expect(new Set(tiles.map(({ id }) => id))).toHaveLength(144);
  });

  it.each([
    [0, { type: "suited", suit: "characters", rank: 1 }],
    [3, { type: "suited", suit: "characters", rank: 1 }],
    [4, { type: "suited", suit: "characters", rank: 2 }],
    [35, { type: "suited", suit: "characters", rank: 9 }],
    [36, { type: "suited", suit: "circles", rank: 1 }],
    [71, { type: "suited", suit: "circles", rank: 9 }],
    [72, { type: "suited", suit: "bamboo", rank: 1 }],
    [107, { type: "suited", suit: "bamboo", rank: 9 }],
    [108, { type: "wind", wind: "east" }],
    [111, { type: "wind", wind: "east" }],
    [112, { type: "wind", wind: "south" }],
    [123, { type: "wind", wind: "north" }],
    [124, { type: "dragon", dragon: "red" }],
    [127, { type: "dragon", dragon: "red" }],
    [128, { type: "dragon", dragon: "green" }],
    [131, { type: "dragon", dragon: "green" }],
    [132, { type: "dragon", dragon: "white" }],
    [135, { type: "dragon", dragon: "white" }],
    [
      136,
      {
        type: "bonus",
        family: "season",
        name: "spring",
        number: 1,
        matchingSeat: "east",
      },
    ],
    [
      139,
      {
        type: "bonus",
        family: "season",
        name: "winter",
        number: 4,
        matchingSeat: "north",
      },
    ],
    [
      140,
      {
        type: "bonus",
        family: "flower",
        name: "plum",
        number: 1,
        matchingSeat: "east",
      },
    ],
    [
      143,
      {
        type: "bonus",
        family: "flower",
        name: "bamboo",
        number: 4,
        matchingSeat: "north",
      },
    ],
  ] as const)("assigns canonical tile ID %i", (id, expectedKind) => {
    expect(tiles[id]).toEqual({ id, kind: expectedKind });
  });
});
