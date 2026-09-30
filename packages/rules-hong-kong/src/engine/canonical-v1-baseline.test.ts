import { describe, expect, it } from "vitest";

import { canonicalJson } from "./game-codec.js";
import {
  canonicalEventHashPayload,
  canonicalGameEventJson,
  canonicalGameJson,
  decodeCanonicalGameEventJson,
  decodeCanonicalGameJson,
} from "./game-serialization.js";
import { startHongKongV1Game } from "./game-setup.js";

const actors = {
  east: "actor:east",
  south: "actor:south",
  west: "actor:west",
  north: "actor:north",
};

const randomness = Uint8Array.from(
  { length: 1_028 },
  (_, index) => (index * 73 + 41) & 0xff,
);

describe("initial canonical v1 baseline", () => {
  it("round-trips the current rich genesis state and event", () => {
    const { event, state } = startHongKongV1Game(actors, randomness);

    expect(state.schemaVersion).toBe(1);
    expect(state.players.east.melds).toEqual([]);
    expect(decodeCanonicalGameJson(canonicalGameJson(state))).toEqual(state);
    expect(decodeCanonicalGameEventJson(canonicalGameEventJson(event))).toEqual(
      event,
    );
    expect(JSON.parse(canonicalEventHashPayload(null, event))).toEqual({
      event,
      previousHash: null,
      version: 1,
    });
  });

  it("rejects prior lean and version 2 encodings", () => {
    const { event, state } = startHongKongV1Game(actors, randomness);
    const lean = Object.fromEntries(
      Object.entries(state).filter(([key]) => key !== "completionProvenance"),
    );

    expect(() => decodeCanonicalGameJson(canonicalJson(lean))).toThrow(
      /Unsupported canonical game encoding/u,
    );
    expect(() =>
      decodeCanonicalGameJson(canonicalJson({ ...state, schemaVersion: 2 })),
    ).toThrow(/Unsupported canonical game encoding/u);
    expect(() =>
      decodeCanonicalGameEventJson(
        canonicalJson({ ...event, state: { ...state, schemaVersion: 2 } }),
      ),
    ).toThrow();
  });
});
