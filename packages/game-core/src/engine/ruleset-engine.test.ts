import { describe, expect, it } from "vitest";

import { decodeGenesisSnapshot, replayEventTail } from "./ruleset-engine.js";

describe("genesis snapshot", () => {
  const snapshot = {
    formatVersion: 1,
    eventSequence: 0,
    ruleset: { id: "test-rules", version: 1 },
    configuration: { target: 3 },
    state: { count: 0 },
  } as const;

  it("round-trips through JSON and decodes the replay root", () => {
    expect(
      decodeGenesisSnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown),
    ).toEqual(snapshot);
  });

  it.each([
    { ...snapshot, formatVersion: 2 },
    { ...snapshot, eventSequence: 1 },
    { ...snapshot, ruleset: { id: "", version: 1 } },
    { ...snapshot, ruleset: { id: "test-rules", version: 0 } },
    { ...snapshot, state: { count: Number.NaN } },
  ])("rejects an incompatible or invalid replay root", (value) => {
    expect(() => decodeGenesisSnapshot(value)).toThrow(TypeError);
  });
});

describe("replayEventTail", () => {
  it("reduces an ordered multi-event tail from genesis sequence zero", () => {
    const state = replayEventTail(
      { count: 0 },
      [{ amount: 2 }, { amount: -1 }, { amount: 4 }],
      (current, event) => ({ count: current.count + event.amount }),
    );

    expect(state).toEqual({ count: 5 });
  });
});
