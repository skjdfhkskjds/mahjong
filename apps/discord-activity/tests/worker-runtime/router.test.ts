import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/worker/env.js";
import { routeRequest } from "../../src/worker/router.js";

const origin = "https://activity.example";
const discordClientId = "123";
const discordProxyOrigin = `https://${discordClientId}.discordsays.com`;
const tableId = "dGVzdC10YWJsZS1pZC0xNg";
const bindingProof = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sessionId = "c2Vzc2lvbi1pZC13aXRoLWV4YWN0bHktMzItYnl0ZXM";

function activityInstances(
  responseForPath?: (path: string) => Response | undefined,
): Env["ACTIVITY_INSTANCE"] {
  return {
    getByName: () =>
      ({
        fetch: (request: Request | string) => {
          const path = new URL(
            typeof request === "string" ? request : request.url,
          ).pathname;
          const customResponse = responseForPath?.(path);
          if (customResponse !== undefined) {
            return Promise.resolve(customResponse);
          }
          if (path === "/internal/sessions/issue") {
            return Promise.resolve(
              Response.json({
                access: "member",
                binding: {
                  bindingGeneration: 1,
                  bindingProof,
                  state: "bound",
                  tableId,
                  version: 1,
                },
                role: "owner",
                sessionGeneration: 1,
                sessionId,
                version: 1,
              }),
            );
          }
          return Promise.resolve(
            Response.json({
              access: "member",
              binding: {
                bindingGeneration: 1,
                bindingProof,
                state: "bound",
                tableId,
                version: 1,
              },
              role: "owner",
              valid: true,
              version: 1,
            }),
          );
        },
      }) as DurableObjectStub,
  } as unknown as Env["ACTIVITY_INSTANCE"];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ACTIVITY_INSTANCE: activityInstances(),
    APP_MODE: "mock",
    ASSETS: {
      fetch: () => Promise.resolve(new Response("asset")),
    } as unknown as Fetcher,
    SESSION_COOKIE_NAME: "mahjong_session",
    SESSION_SIGNING_KEY: "test-secret-that-is-at-least-thirty-two-bytes-long",
    SESSION_TTL_SECONDS: "900",
    TABLE_ROOM: {} as DurableObjectNamespace,
    ...overrides,
  } as Env;
}

describe("Worker router", () => {
  it("serves the shared health contract and rejects unsafe methods", async () => {
    const response = await routeRequest(
      new Request(`${origin}/api/health`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "mock",
      status: "ok",
    });

    const rejected = await routeRequest(
      new Request(`${origin}/api/health`, { method: "POST" }),
      testEnv(),
    );
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("returns JSON 404 responses for unknown API routes", async () => {
    const response = await routeRequest(
      new Request(`${origin}/api/unknown`),
      testEnv(),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("requires same-origin JSON before issuing a mock session", async () => {
    const missingOrigin = await routeRequest(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "East" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      testEnv(),
    );
    expect(missingOrigin.status).toBe(403);

    const created = await routeRequest(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: " East " }),
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        method: "POST",
      }),
      testEnv(),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("Set-Cookie")).toContain(
      "HttpOnly; SameSite=Lax",
    );
    const body = await created.json<unknown>();
    expect(body).toMatchObject({
      access: "member",
      actor: { displayName: "East" },
      authenticated: true,
      instanceId: "standalone-local-instance",
      mode: "mock",
      role: "owner",
      tableId,
    });
    expect((body as Record<string, unknown>)["csrfToken"]).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );

    const cookie = created.headers.get("Set-Cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("Expected a session cookie.");
    const current = await routeRequest(
      new Request(`${origin}/api/session`, {
        headers: { Cookie: cookie },
      }),
      testEnv(),
    );
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      access: "member",
      authenticated: true,
      instanceId: "standalone-local-instance",
      mode: "mock",
      role: "owner",
      tableId,
    });
  });

  it("does not expose mock authentication in Discord mode", async () => {
    const response = await routeRequest(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "East" }),
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        method: "POST",
      }),
      testEnv({ APP_MODE: "discord" }),
    );
    expect(response.status).toBe(404);
  });

  it("rejects unsafe authenticated mutations before forwarding them", async () => {
    const activityPaths: string[] = [];
    const currentEnv = testEnv({
      ACTIVITY_INSTANCE: activityInstances((path) => {
        activityPaths.push(path);
        return undefined;
      }),
    });
    const authenticated = await routeRequest(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "Policy Player" }),
        headers: { "Content-Type": "application/json", Origin: origin },
        method: "POST",
      }),
      currentEnv,
    );
    const cookie = authenticated.headers.get("Set-Cookie")?.split(";", 1)[0];
    const csrfToken = (
      await authenticated.json<{ readonly csrfToken?: string }>()
    ).csrfToken;
    if (cookie === undefined || csrfToken === undefined) {
      throw new Error("Expected an authenticated policy-test session.");
    }

    const mutations = [
      {
        body: { invitedActorId: "205519959982473217" },
        internalPath: "/internal/invitations/create",
        publicPath: "/api/table/invitations",
      },
      {
        body: { capability: "invalid-but-policy-checked-first" },
        internalPath: "/internal/invitations/redeem",
        publicPath: "/api/table/invitations/redeem",
      },
      {
        body: {},
        internalPath: "/internal/resume-capabilities/create",
        publicPath: "/api/table/resume-capabilities",
      },
      {
        body: {},
        internalPath: "/internal/sessions/revoke",
        publicPath: "/api/session/logout",
      },
    ] as const;
    const rejectedPolicies = [
      {
        name: "missing Origin",
        status: 403,
        change: (headers: Headers) => {
          headers.delete("Origin");
        },
      },
      {
        name: "wrong Origin",
        status: 403,
        change: (headers: Headers) => {
          headers.set("Origin", "https://attacker.example");
        },
      },
      {
        name: "wrong content type",
        status: 415,
        change: (headers: Headers) => {
          headers.set("Content-Type", "text/plain");
        },
      },
      {
        name: "missing CSRF token",
        status: 403,
        change: (headers: Headers) => {
          headers.delete("X-CSRF-Token");
        },
      },
      {
        name: "wrong CSRF token",
        status: 403,
        change: (headers: Headers) => {
          headers.set("X-CSRF-Token", "wrong-token");
        },
      },
    ] as const;

    for (const mutation of mutations) {
      for (const policy of rejectedPolicies) {
        activityPaths.length = 0;
        const headers = new Headers({
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": csrfToken,
        });
        policy.change(headers);
        const response = await routeRequest(
          new Request(`${origin}${mutation.publicPath}`, {
            body: JSON.stringify(mutation.body),
            headers,
            method: "POST",
          }),
          currentEnv,
        );

        expect(
          response.status,
          `${mutation.publicPath} with ${policy.name}`,
        ).toBe(policy.status);
        expect(activityPaths).not.toContain(mutation.internalPath);
      }
    }
  });

  it("rejects public JSON bodies larger than the request limit", async () => {
    const response = await routeRequest(
      new Request(`${origin}/api/auth/mock`, {
        body: JSON.stringify({ displayName: "x".repeat(4_096) }),
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        method: "POST",
      }),
      testEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid-request" },
    });
  });

  it("fails closed when Discord instance verification credentials are missing", async () => {
    const response = await routeRequest(
      new Request(`${origin}/api/auth/discord/exchange`, {
        body: JSON.stringify({ code: "code", instanceId: "instance" }),
        headers: {
          "Content-Type": "application/json",
          Origin: discordProxyOrigin,
        },
        method: "POST",
      }),
      testEnv({
        APP_MODE: "discord",
        DISCORD_CLIENT_ID: discordClientId,
        DISCORD_CLIENT_SECRET: "secret",
        SESSION_COOKIE_NAME: "__Host-mahjong_session",
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid-configuration" },
    });
  });

  it("rejects non-proxy Discord origins for exchange and socket requests", async () => {
    const currentEnv = testEnv({
      APP_MODE: "discord",
      DISCORD_CLIENT_ID: discordClientId,
      SESSION_COOKIE_NAME: "__Host-mahjong_session",
    });
    const exchange = await routeRequest(
      new Request(`${origin}/api/auth/discord/exchange`, {
        body: JSON.stringify({ code: "code", instanceId: "instance" }),
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        method: "POST",
      }),
      currentEnv,
    );
    expect(exchange.status).toBe(403);

    const socket = await routeRequest(
      new Request(`${origin}/api/table/socket`, {
        headers: { Origin: origin, Upgrade: "websocket" },
      }),
      currentEnv,
    );
    expect(socket.status).toBe(403);

    const allowedSocket = await routeRequest(
      new Request(`${origin}/api/table/socket`, {
        headers: { Origin: discordProxyOrigin, Upgrade: "websocket" },
      }),
      currentEnv,
    );
    expect(allowedSocket.status).toBe(401);
  });

  it("preserves typed ActivityInstance binding failures after Discord verification", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation
      .mockResolvedValueOnce(Response.json({ access_token: "access-token" }))
      .mockResolvedValueOnce(
        Response.json({
          global_name: "East Player",
          id: "205519959982473217",
          username: "east",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          application_id: "123",
          instance_id: "verified-instance",
          users: ["205519959982473217"],
        }),
      );
    vi.stubGlobal("fetch", fetchImplementation);
    const instanceProblem = {
      error: {
        code: "binding-in-progress",
        message: "A different table binding is already in progress.",
      },
    };
    const response = await routeRequest(
      new Request(`${origin}/api/auth/discord/exchange`, {
        body: JSON.stringify({
          code: "authorization-code",
          instanceId: "verified-instance",
        }),
        headers: {
          "Content-Type": "application/json",
          Origin: discordProxyOrigin,
        },
        method: "POST",
      }),
      testEnv({
        ACTIVITY_INSTANCE: activityInstances((path) =>
          path === "/internal/sessions/issue"
            ? Response.json(instanceProblem, { status: 409 })
            : undefined,
        ),
        APP_MODE: "discord",
        DISCORD_BOT_TOKEN: "bot-token",
        DISCORD_CLIENT_ID: discordClientId,
        DISCORD_CLIENT_SECRET: "client-secret",
        SESSION_COOKIE_NAME: "__Host-mahjong_session",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(instanceProblem);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an invalid cookie name", { SESSION_COOKIE_NAME: "bad name" }],
    ["a short current key", { SESSION_SIGNING_KEY: "too-short" }],
    ["a short previous key", { SESSION_SIGNING_KEY_PREVIOUS: "too-short" }],
    [
      "a non-__Host cookie in Discord mode",
      {
        APP_MODE: "discord" as const,
        SESSION_COOKIE_NAME: "mahjong_session",
      },
    ],
  ])("rejects %s", async (_description, override) => {
    const response = await routeRequest(
      new Request(`${origin}/api/session`),
      testEnv(override),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid-configuration" },
    });
  });
});
