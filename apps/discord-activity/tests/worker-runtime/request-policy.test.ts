import { describe, expect, it } from "vitest";

import {
  allowedOrigins,
  hasAllowedOrigin,
  hasJsonContentType,
} from "../../src/worker/http/request-policy.js";

describe("Worker request policy", () => {
  it("accepts JSON with parameters and rejects lookalike media types", () => {
    expect(
      hasJsonContentType(
        new Request("https://activity.example/api", {
          headers: { "Content-Type": "Application/JSON; Charset=UTF-8" },
        }),
      ),
    ).toBe(true);
    expect(
      hasJsonContentType(
        new Request("https://activity.example/api", {
          headers: { "Content-Type": "application/json-patch+json" },
        }),
      ),
    ).toBe(false);
  });

  it("requires an exact configured HTTP origin", () => {
    const request = new Request("https://activity.example/api", {
      headers: { Origin: "https://activity.example" },
    });
    expect(
      hasAllowedOrigin(
        request,
        "https://activity.example, http://localhost:5173, *, malformed",
      ),
    ).toBe(true);
    expect(allowedOrigins("*, malformed")).toEqual(new Set());
    expect(
      hasAllowedOrigin(
        new Request("https://activity.example/api"),
        "https://activity.example",
      ),
    ).toBe(false);
  });
});
