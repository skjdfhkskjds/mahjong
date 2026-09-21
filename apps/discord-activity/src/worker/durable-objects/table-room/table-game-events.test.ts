import { describe, expect, it } from "vitest";
import {
  HONG_KONG_V1_RANDOM_BYTES,
  startHongKongV2Game,
} from "@mahjong/rules-hong-kong";

import { prepareGameEventBatch } from "./table-game-events.js";

describe("application canonical event preparation", () => {
  it("prepares genesis and its checkpoint without a storage runtime", async () => {
    const started = startHongKongV2Game(
      { east: "east", south: "south", west: "west", north: "north" },
      new Uint8Array(HONG_KONG_V1_RANDOM_BYTES),
    );
    const payloads: string[] = [];
    const batch = await prepareGameEventBatch(
      undefined,
      [started.event],
      (payload) => {
        payloads.push(payload);
        return Promise.resolve("a".repeat(64));
      },
    );
    expect(batch.finalState).toEqual(started.state);
    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0].previousHash).toBeNull();
    expect(batch.lastEventHash).toBe("a".repeat(64));
    expect(JSON.parse(batch.finalStateJson)).toEqual(started.state);
    expect(payloads).toHaveLength(1);
  });

  it("rejects invalid digest output before preparing writes", async () => {
    const started = startHongKongV2Game(
      { east: "east", south: "south", west: "west", north: "north" },
      new Uint8Array(HONG_KONG_V1_RANDOM_BYTES),
    );
    await expect(
      prepareGameEventBatch(undefined, [started.event], () =>
        Promise.resolve("invalid"),
      ),
    ).rejects.toThrow("lowercase SHA-256");
  });
});
