import { describe, expect, it } from "vitest";

import { tileId } from "./tile-id.js";

describe("tileId", () => {
  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid physical identity %s", (value) => {
    expect(() => tileId(value)).toThrow(TypeError);
  });

  it("accepts a non-negative safe integer", () => {
    expect(tileId(143)).toBe(143);
  });
});
