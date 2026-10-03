import { describe, expect, it } from "vitest";

import { accept, reject } from "./decision.js";

describe("decision constructors", () => {
  it("creates a non-empty accepted event list", () => {
    expect(accept({ type: "first" }, { type: "second" })).toEqual({
      accepted: true,
      events: [{ type: "first" }, { type: "second" }],
    });
  });

  it("creates a non-empty rejected violation list", () => {
    expect(
      reject({ code: "not-legal", message: "That action is not legal." }),
    ).toEqual({
      accepted: false,
      violations: [{ code: "not-legal", message: "That action is not legal." }],
    });
  });
});
