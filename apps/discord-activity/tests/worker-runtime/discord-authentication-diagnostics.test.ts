import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyDiscordActivityInstance } from "../../src/worker/integrations/discord/discord-activity-instance.js";
import { exchangeDiscordIdentity } from "../../src/worker/integrations/discord/discord-oauth.js";

const warnings = vi.fn();

beforeEach(() => {
  warnings.mockClear();
  vi.stubGlobal("console", { ...console, warn: warnings });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Discord authentication diagnostics", () => {
  it.each([
    ["invalid_client", "invalid-client"],
    ["invalid_grant", "invalid-grant"],
    ["private upstream error", "http-error"],
  ])(
    "allowlists OAuth failure %s without logging its body",
    async (error, reason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json(
            {
              error,
              error_description: "private upstream description",
              access_token: "private-token",
            },
            { status: 401 },
          ),
        ),
      );

      await expect(
        exchangeDiscordIdentity("private-code", "123", "private-secret"),
      ).rejects.toThrow("Discord OAuth exchange failed.");
      expect(warnings).toHaveBeenCalledExactlyOnceWith({
        event: "discord-authentication-failed",
        stage: "oauth-token",
        reason,
        status: 401,
      });
    },
  );

  it("identifies malformed user data without logging identity or tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ access_token: "private-token" }))
        .mockResolvedValueOnce(
          Response.json({ id: "private-invalid-id", username: "private-name" }),
        ),
    );

    await expect(
      exchangeDiscordIdentity("private-code", "123", "private-secret"),
    ).rejects.toThrow("Discord user lookup failed.");
    expect(warnings).toHaveBeenCalledExactlyOnceWith({
      event: "discord-authentication-failed",
      stage: "oauth-user",
      reason: "invalid-response",
      status: 200,
    });
  });

  it("omits sensitive details from thrown network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("private request data")),
    );

    await expect(
      exchangeDiscordIdentity("private-code", "123", "private-secret"),
    ).rejects.toThrow("Discord authentication request failed.");
    expect(warnings).toHaveBeenCalledExactlyOnceWith({
      event: "discord-authentication-failed",
      stage: "oauth-token",
      reason: "network-error",
    });
  });

  it.each([200, 401, 403, 404, 429, 500])(
    "identifies instance verification HTTP %i without logging membership",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json(
            {
              application_id: "123",
              instance_id: "private-instance",
              users: ["999"],
            },
            { status },
          ),
        ),
      );

      await expect(
        verifyDiscordActivityInstance({
          applicationId: "123",
          botToken: "private-bot-token",
          instanceId: "private-instance",
          userId: "456",
        }),
      ).rejects.toThrow("Discord Activity instance verification failed.");
      expect(warnings).toHaveBeenCalledExactlyOnceWith({
        event: "discord-authentication-failed",
        stage: "activity-instance",
        reason: status === 200 ? "invalid-response" : "http-error",
        status,
      });
    },
  );
});
