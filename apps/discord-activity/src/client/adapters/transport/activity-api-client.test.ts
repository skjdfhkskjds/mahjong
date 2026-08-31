import { describe, expect, it, vi } from "vitest";

import {
  HttpActivityApi,
  parseDiscordExchangeResponse,
  parseHealthResponse,
  parseSessionResponse,
} from "./activity-api-client.js";
import type { ActivityApiError } from "./activity-api-client.js";

const authenticatedSession = {
  authenticated: true,
  access: "member",
  role: "owner",
  mode: "mock",
  actor: { id: "mock:1", displayName: "Local Player" },
  expiresAt: "2026-08-23T13:00:00.000Z",
  csrfToken: "csrf-value",
  instanceId: "instance-1",
  tableId: "dGVzdC10YWJsZS1pZC0xNg",
} as const;
const invitationCapability = `v1.${authenticatedSession.tableId}.${"A".repeat(22)}.${"B".repeat(43)}`;
const resumeCapability = `v1.${authenticatedSession.tableId}.${"C".repeat(22)}.${"D".repeat(43)}`;

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
    const value: Record<string, unknown> = { ...authenticatedSession };
    delete value["actor"];
    expect(() => parseSessionResponse(value)).toThrow("actor");
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
        authenticated: true,
        access: "member",
        role: "owner",
        mode: "discord",
        actor: { id: "1", displayName: "Player" },
        expiresAt: "2026-08-23T13:00:00.000Z",
        csrfToken: "csrf-value",
        instanceId: "instance-1",
        tableId: "dGVzdC10YWJsZS1pZC0xNg",
      }),
    ).toThrow("accessToken");
  });

  it("requires a CSRF token for an authenticated session", () => {
    expect(() =>
      parseSessionResponse({
        authenticated: true,
        access: "member",
        role: "owner",
        mode: "mock",
        actor: { id: "1", displayName: "Player" },
        expiresAt: "2026-08-23T13:00:00.000Z",
        instanceId: "instance-1",
        tableId: "dGVzdC10YWJsZS1pZC0xNg",
      }),
    ).toThrow("csrfToken");
  });

  it("keeps the CSRF token ready for authenticated mutation headers", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation.mockResolvedValue(
      new Response(JSON.stringify(authenticatedSession), { status: 201 }),
    );
    const api = new HttpActivityApi("", fetchImplementation);

    await api.createMockSession("Local Player", new AbortController().signal);

    expect(api.headersForAuthenticatedMutation().get("x-csrf-token")).toBe(
      "csrf-value",
    );
  });

  it("requires table access, instance, and table fields", () => {
    for (const field of ["access", "instanceId", "tableId", "role"] as const) {
      const value: Record<string, unknown> = {
        ...authenticatedSession,
        [field]: undefined,
      };
      expect(() => parseSessionResponse(value)).toThrow();
    }
    expect(() =>
      parseSessionResponse({ ...authenticatedSession, access: "owner" }),
    ).toThrow("access");
  });

  it("sends capability mutations with the current CSRF token", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation
      .mockResolvedValueOnce(
        Response.json(authenticatedSession, { status: 201 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          capability: invitationCapability,
          expiresAt: 1_787_477_200_000,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          tableId: authenticatedSession.tableId,
          role: "member",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          capability: resumeCapability,
          expiresAt: 1_787_477_200_000,
        }),
      );
    const api = new HttpActivityApi("", fetchImplementation);
    const signal = new AbortController().signal;
    await api.createMockSession("Local Player", signal);

    await api.createInvitation("205519959982473217", signal);
    await api.redeemInvitation(invitationCapability, signal);
    await api.createResumeCapability(signal);

    for (const call of fetchImplementation.mock.calls.slice(1)) {
      const init = call[1];
      expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-value");
      expect(init).toMatchObject({ credentials: "include", method: "POST" });
    }
  });

  it("rejects malformed capability responses", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation
      .mockResolvedValueOnce(
        Response.json(authenticatedSession, { status: 201 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          capability: "not-a-capability",
          expiresAt: 1,
        }),
      );
    const api = new HttpActivityApi("", fetchImplementation);
    const signal = new AbortController().signal;
    await api.createMockSession("Local Player", signal);

    await expect(
      api.createInvitation("205519959982473217", signal),
    ).rejects.toThrow("capability");
  });

  it("serializes an optional resume capability during Discord exchange", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation.mockResolvedValue(
      Response.json({
        ...authenticatedSession,
        mode: "discord",
        accessToken: "access-token",
      }),
    );
    const api = new HttpActivityApi("", fetchImplementation);

    await api.exchangeDiscordCode(
      { code: "authorization-code" },
      { instanceId: "instance-1" },
      new AbortController().signal,
      resumeCapability,
    );

    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") throw new Error("Expected a JSON body.");
    expect(JSON.parse(body)).toEqual({
      code: "authorization-code",
      instanceId: "instance-1",
      resumeCapability,
    });
  });

  it("exposes structured API problem codes and clears CSRF after logout", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    fetchImplementation
      .mockResolvedValueOnce(
        Response.json(authenticatedSession, { status: 201 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "capability-consumed",
              message: "The capability was already used.",
            },
          },
          { status: 410 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new HttpActivityApi("", fetchImplementation);
    const signal = new AbortController().signal;
    await api.createMockSession("Local Player", signal);

    const rejection = api.redeemInvitation("used", signal);
    await expect(rejection).rejects.toMatchObject({
      code: "capability-consumed",
      status: 410,
    } satisfies Partial<ActivityApiError>);
    await api.logout(signal);
    const logoutRequest = fetchImplementation.mock.calls.at(-1)?.[1];
    expect(new Headers(logoutRequest?.headers).get("x-csrf-token")).toBe(
      "csrf-value",
    );
    expect(logoutRequest?.body).toBe("{}");
    expect(() => api.headersForAuthenticatedMutation()).toThrow(
      "authenticated session",
    );
  });
});
