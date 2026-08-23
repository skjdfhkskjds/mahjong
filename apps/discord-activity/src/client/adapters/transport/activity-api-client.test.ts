import { describe, expect, it, vi } from "vitest";

import {
  HttpActivityApi,
  parseDiscordExchangeResponse,
  parseHealthResponse,
  parseSessionResponse,
} from "./activity-api-client.js";

describe("Activity API response parsing", () => {
  it("parses the health contract", () => {
    expect(
      parseHealthResponse({
        status: "ok",
        mode: "mock",
        now: "2026-08-23T12:00:00.000Z",
      }),
    ).toEqual({
      status: "ok",
      mode: "mock",
      now: "2026-08-23T12:00:00.000Z",
    });
  });

  it("requires actor details for an authenticated session", () => {
    expect(() =>
      parseSessionResponse({ authenticated: true, mode: "mock" }),
    ).toThrow("actor");
  });

  it("does not retain an actor on an unauthenticated response", () => {
    expect(
      parseSessionResponse({
        authenticated: false,
        mode: "discord",
        actor: { id: "untrusted", displayName: "Ignored" },
      }),
    ).toEqual({ authenticated: false, mode: "discord" });
  });

  it("requires an access token only from Discord exchange", () => {
    expect(() =>
      parseDiscordExchangeResponse({
        mode: "discord",
        actor: { id: "1", displayName: "Player" },
        expiresAt: "2026-08-23T13:00:00.000Z",
        csrfToken: "csrf-value",
      }),
    ).toThrow("accessToken");
  });

  it("requires a CSRF token for an authenticated session", () => {
    expect(() =>
      parseSessionResponse({
        authenticated: true,
        mode: "mock",
        actor: { id: "1", displayName: "Player" },
        expiresAt: "2026-08-23T13:00:00.000Z",
      }),
    ).toThrow("csrfToken");
  });

  it("keeps the CSRF token ready for authenticated mutation headers", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation.mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: "mock",
          actor: { id: "mock:1", displayName: "Local Player" },
          expiresAt: "2026-08-23T13:00:00.000Z",
          csrfToken: "csrf-value",
        }),
        { status: 201 },
      ),
    );
    const api = new HttpActivityApi("", fetchImplementation);

    await api.createMockSession("Local Player", new AbortController().signal);

    expect(api.headersForAuthenticatedMutation().get("x-csrf-token")).toBe(
      "csrf-value",
    );
  });
});
