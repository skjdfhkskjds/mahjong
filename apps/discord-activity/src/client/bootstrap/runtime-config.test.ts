import { describe, expect, it, vi } from "vitest";

import {
  readBrowserRuntimeConfig,
  readRuntimeConfig,
  RuntimeConfigurationError,
} from "./runtime-config.js";

describe("runtime configuration", () => {
  it("defaults to a safe standalone mock identity", () => {
    expect(readRuntimeConfig("", {})).toEqual({
      mode: "mock",
      apiBaseUrl: "",
      mockActor: { id: "mock-player-1", displayName: "Local Player" },
    });
  });

  it("reads Vite's browser environment without aliasing import.meta", () => {
    vi.stubGlobal("window", { location: { search: "" } });
    try {
      expect(readBrowserRuntimeConfig()).toMatchObject({ mode: "mock" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows the query string to select Discord mode", () => {
    expect(
      readRuntimeConfig("?activity_mode=discord", {
        VITE_ACTIVITY_MODE: "mock",
        VITE_DISCORD_CLIENT_ID: "1234",
      }),
    ).toMatchObject({ mode: "discord", discordClientId: "1234" });
  });

  it("requires a client ID in Discord mode", () => {
    expect(() =>
      readRuntimeConfig("", { VITE_ACTIVITY_MODE: "discord" }),
    ).toThrow(RuntimeConfigurationError);
  });

  it("rejects unknown modes instead of silently changing trust context", () => {
    expect(() => readRuntimeConfig("?activity_mode=preview", {})).toThrow(
      'Expected "mock" or "discord"',
    );
  });

  it("normalizes an API base URL", () => {
    expect(
      readRuntimeConfig("", { VITE_API_BASE_URL: "http://localhost:8787///" })
        .apiBaseUrl,
    ).toBe("http://localhost:8787");
  });
});
