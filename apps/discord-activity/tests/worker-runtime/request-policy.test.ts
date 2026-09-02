import { describe, expect, it } from "vitest";

import {
  allowedOrigins,
  hasAllowedOrigin,
  hasExpectedActivityOrigin,
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

  it("accepts only the configured Discord application proxy origin", () => {
    const workerUrl = "https://activity-worker.example/api";
    expect(
      hasExpectedActivityOrigin(
        new Request(workerUrl, {
          headers: { Origin: "https://123456789.discordsays.com" },
        }),
        "discord",
        "123456789",
      ),
    ).toBe(true);

    for (const suppliedOrigin of [
      "https://activity-worker.example",
      "https://987654321.discordsays.com",
      "https://123456789.discordsays.com.attacker.example",
    ]) {
      expect(
        hasExpectedActivityOrigin(
          new Request(workerUrl, {
            headers: { Origin: suppliedOrigin },
          }),
          "discord",
          "123456789",
        ),
      ).toBe(false);
    }
    expect(
      hasExpectedActivityOrigin(
        new Request(workerUrl, {
          headers: { Origin: "https://123456789.discordsays.com" },
        }),
        "discord",
      ),
    ).toBe(false);
  });
});
