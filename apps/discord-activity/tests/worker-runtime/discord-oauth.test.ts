import { afterEach, describe, expect, it, vi } from "vitest";

import { exchangeDiscordIdentity } from "../../src/worker/integrations/discord/discord-oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Discord OAuth identity exchange", () => {
  it("exchanges form data and resolves the trusted user", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation
      .mockResolvedValueOnce(
        Response.json({ access_token: "short-lived-access-token" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          global_name: "East Player",
          id: "205519959982473217",
          username: "east",
        }),
      );
    vi.stubGlobal("fetch", fetchImplementation);

    await expect(
      exchangeDiscordIdentity("authorization-code", "123", "client-secret"),
    ).resolves.toEqual({
      accessToken: "short-lived-access-token",
      actor: { displayName: "East Player", id: "205519959982473217" },
    });
    const tokenCall = fetchImplementation.mock.calls[0];
    expect(tokenCall?.[0]).toBe("https://discord.com/api/v10/oauth2/token");
    expect(tokenCall?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(tokenCall?.[1]?.body).toBeInstanceOf(URLSearchParams);
    expect(
      (tokenCall?.[1]?.body as URLSearchParams | undefined)?.get("grant_type"),
    ).toBe("authorization_code");
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      "https://discord.com/api/v10/users/@me",
      {
        headers: { Authorization: "Bearer short-lived-access-token" },
        redirect: "error",
      },
    );
  });

  it.each([
    ["a rejected token exchange", new Response(null, { status: 401 })],
    ["a malformed token response", Response.json({ access_token: 1 })],
    [
      "an oversized token response",
      Response.json({ access_token: "x", padding: "x".repeat(65_536) }),
    ],
  ])("rejects %s", async (_label, tokenResponse) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation.mockResolvedValue(tokenResponse);
    vi.stubGlobal("fetch", fetchImplementation);

    await expect(
      exchangeDiscordIdentity("authorization-code", "123", "client-secret"),
    ).rejects.toThrow("Discord OAuth exchange failed.");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid trusted user response", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation
      .mockResolvedValueOnce(Response.json({ access_token: "access-token" }))
      .mockResolvedValueOnce(Response.json({ id: "browser-chosen" }));
    vi.stubGlobal("fetch", fetchImplementation);

    await expect(
      exchangeDiscordIdentity("authorization-code", "123", "client-secret"),
    ).rejects.toThrow("Discord user lookup failed.");
  });
});
