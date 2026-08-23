import { describe, expect, it } from "vitest";

import { commandId, handId, playerId, tableId } from "./identifiers.js";

describe("domain identifiers", () => {
  it.each([
    ["playerId", playerId],
    ["tableId", tableId],
    ["handId", handId],
    ["commandId", commandId],
  ] as const)("rejects an empty %s", (_name, createId) => {
    expect(() => createId(" \n\t")).toThrow(TypeError);
  });

  it("preserves the supplied stable value", () => {
    expect(playerId("discord:123")).toBe("discord:123");
  });
});
