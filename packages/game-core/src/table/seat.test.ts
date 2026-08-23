import { describe, expect, it } from "vitest";

import { nextSeat, seat, seats } from "./seat.js";

describe("seat order", () => {
  it("uses East, South, West, North turn order", () => {
    expect(seats).toEqual(["east", "south", "west", "north"]);
  });

  it.each([
    ["east", "south"],
    ["south", "west"],
    ["west", "north"],
    ["north", "east"],
  ] as const)("advances %s to %s", (current, expected) => {
    expect(nextSeat(seat(current))).toBe(expected);
  });
});
