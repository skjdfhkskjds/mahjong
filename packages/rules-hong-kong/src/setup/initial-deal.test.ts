import { describe, expect, it } from "vitest";

import { initialDealSeatOrder } from "./initial-deal.js";

describe("hong-kong/v1 initial deal", () => {
  const packetRound = [
    ...Array.from({ length: 4 }, () => "east" as const),
    ...Array.from({ length: 4 }, () => "south" as const),
    ...Array.from({ length: 4 }, () => "west" as const),
    ...Array.from({ length: 4 }, () => "north" as const),
  ];

  it("deals three four-tile packet rounds then East 2 and all other seats 1", () => {
    expect(initialDealSeatOrder).toHaveLength(53);
    expect(initialDealSeatOrder.slice(0, 16)).toEqual(packetRound);
    expect(initialDealSeatOrder.slice(16, 32)).toEqual(packetRound);
    expect(initialDealSeatOrder.slice(32, 48)).toEqual(packetRound);
    expect(initialDealSeatOrder.slice(48)).toEqual([
      "east",
      "east",
      "south",
      "west",
      "north",
    ]);
  });

  it.each([
    ["east", 14],
    ["south", 13],
    ["west", 13],
    ["north", 13],
  ] as const)("assigns %s %i raw tile slots", (seat, expected) => {
    expect(
      initialDealSeatOrder.filter((assigned) => assigned === seat),
    ).toHaveLength(expected);
  });
});
