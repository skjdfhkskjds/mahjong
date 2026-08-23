import { describe, expect, it } from "vitest";

import type { Env } from "../../src/worker/env.js";
import { routeRequest } from "../../src/worker/router.js";

const origin = "https://activity.example";
const tableId = "dGVzdC10YWJsZS1pZC0xNg";
const bindingProof = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sessionId = "c2Vzc2lvbi1pZC13aXRoLWV4YWN0bHktMzItYnl0ZXM";

function activityInstances(): DurableObjectNamespace {
  return {
    getByName: () =>
      ({
        fetch: (request: Request | string) => {
          const path = new URL(
            typeof request === "string" ? request : request.url,
          ).pathname;
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
                sessionGeneration: 1,
                sessionId,
                version: 1,
              }),
            );
          }
          return Promise.resolve(
            Response.json({
              binding: {
                bindingGeneration: 1,
                bindingProof,
                state: "bound",
                tableId,
                version: 1,
              },
              valid: true,
              version: 1,
            }),
          );
        },
      }) as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

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
      actor: { displayName: "East" },
      authenticated: true,
      mode: "mock",
    });
    expect((body as Record<string, unknown>)["csrfToken"]).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
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
