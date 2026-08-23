import { describe, expect, it } from "vitest";

import { isJsonValue } from "./json-value.js";

describe("isJsonValue", () => {
  it("accepts nested JSON data", () => {
    expect(
      isJsonValue({ hand: [1, 2, null], ready: true, owner: "east" }),
    ).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["bigint", BigInt(1)],
    ["date", new Date(0)],
    ["map", new Map()],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_name, value) => {
    expect(isJsonValue(value)).toBe(false);
  });
});
