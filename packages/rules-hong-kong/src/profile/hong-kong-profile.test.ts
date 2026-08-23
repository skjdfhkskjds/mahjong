import { describe, expect, it } from "vitest";

import { initialDealSeatOrder } from "../setup/initial-deal.js";
import { createHongKongV1TileSet } from "../wall/create-tile-set.js";
import { parseHongKongProfile } from "./hong-kong-profile.js";
import { hongKongV1Profile } from "./hong-kong-v1.js";

describe("hong-kong/v1 profile", () => {
  it("round-trips as a complete JSON-safe provisional contract", () => {
    expect(
      parseHongKongProfile(
        JSON.parse(JSON.stringify(hongKongV1Profile)) as unknown,
      ),
    ).toEqual(hongKongV1Profile);
  });

  it("rejects a missing required decision", () => {
    const incomplete = Object.fromEntries(
      Object.entries(hongKongV1Profile).filter(([key]) => key !== "wall"),
    );
    expect(() => parseHongKongProfile(incomplete)).toThrow();
  });

  it("rejects silent profile extensions", () => {
    expect(() =>
      parseHongKongProfile({ ...hongKongV1Profile, scoring: {} }),
    ).toThrow();
  });

  it("agrees with the canonical tile inventory and deal helpers", () => {
    expect(createHongKongV1TileSet()).toHaveLength(
      hongKongV1Profile.tileSet.totalTiles,
    );

    for (const seat of hongKongV1Profile.seating.turnOrder) {
      expect(
        initialDealSeatOrder.filter((assigned) => assigned === seat),
      ).toHaveLength(hongKongV1Profile.deal.initialTileSlots[seat]);
    }
  });
});
