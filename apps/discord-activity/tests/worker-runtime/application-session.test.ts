import { describe, expect, it } from "vitest";

import {
  createSessionCookie,
  readApplicationSession,
} from "../../src/worker/auth/application-session.js";

const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
const actor = { displayName: "East Player", id: "mock:east" } as const;
const scope = {
  instanceId: "standalone-local-instance",
  sessionGeneration: 1,
  sessionId: "c2Vzc2lvbi1pZC13aXRoLWV4YWN0bHktMzItYnl0ZXM",
} as const;
const encoder = new TextEncoder();

function requestWithCookie(setCookie: string): Request {
  return new Request("https://activity.example/api/session", {
    headers: { Cookie: setCookie.split(";", 1)[0] ?? "" },
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function rewriteSignedPayload(
  setCookie: string,
  rewrite: (payload: Record<string, unknown>) => void,
): Promise<string> {
  const cookie = setCookie.split(";", 1)[0] ?? "";
  const separator = cookie.indexOf("=");
  const name = cookie.slice(0, separator);
  const [encodedPayload] = cookie.slice(separator + 1).split(".");
  if (encodedPayload === undefined) {
    throw new Error("Session cookie is missing its payload.");
  }
  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(encodedPayload)),
  ) as Record<string, unknown>;
  rewrite(payload);
  const rewrittenPayload = bytesToBase64Url(
    encoder.encode(JSON.stringify(payload)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rewrittenPayload),
  );
  return `${name}=${rewrittenPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

describe("application session boundary", () => {
  it("round-trips a signed, short-lived session", async () => {
    const created = await createSessionCookie(actor, scope, secret, 1_000, {
      mode: "discord",
    });
    expect(created.cookie).toContain(
      "Secure; HttpOnly; SameSite=None; Partitioned",
    );
    await expect(
      readApplicationSession(requestWithCookie(created.cookie), secret, 2_000),
    ).resolves.toEqual(created.session);
    expect(created.session).toMatchObject(scope);
    expect(created.session.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("rejects an expired or modified token", async () => {
    const created = await createSessionCookie(actor, scope, secret, 1_000);
    await expect(
      readApplicationSession(
        requestWithCookie(created.cookie),
        secret,
        created.session.expiresAt,
      ),
    ).resolves.toBeUndefined();

    const cookieHeader = created.cookie.split(";", 1)[0] ?? "";
    const finalCharacter = cookieHeader.at(-1);
    const modified = `${cookieHeader.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
    await expect(
      readApplicationSession(requestWithCookie(modified), secret, 2_000),
    ).resolves.toBeUndefined();
  });

  it("rejects undersized signing secrets", async () => {
    await expect(
      createSessionCookie(actor, scope, "too-short"),
    ).rejects.toThrow(TypeError);
  });

  it("verifies a rotated previous signing key and retains CSRF state", async () => {
    const previous = `${secret}-previous`;
    const created = await createSessionCookie(
      actor,
      { ...scope, sessionGeneration: 7 },
      previous,
      1_000,
    );
    const session = await readApplicationSession(
      requestWithCookie(created.cookie),
      `${secret}-current`,
      2_000,
      undefined,
      previous,
    );
    expect(session?.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(session?.issuedAt).toBe(1_000);
    expect(session?.mode).toBe("mock");
    expect(session?.instanceId).toBe(scope.instanceId);
    expect(session?.sessionGeneration).toBe(7);
    expect(session?.sessionId).toBe(created.session.sessionId);
  });

  it("creates a distinct CSRF token for each credential", async () => {
    const first = await createSessionCookie(actor, scope, secret, 1_000);
    const second = await createSessionCookie(actor, scope, secret, 1_000);

    expect(first.session.sessionId).toBe(scope.sessionId);
    expect(second.session.sessionId).toBe(scope.sessionId);
    expect(first.session.csrfToken).not.toBe(second.session.csrfToken);
  });

  it.each([
    ["an empty instance ID", { ...scope, instanceId: "" }],
    [
      "an invalid instance ID",
      { ...scope, instanceId: "instance\nwith-control" },
    ],
    ["a zero generation", { ...scope, sessionGeneration: 0 }],
    ["a non-integer generation", { ...scope, sessionGeneration: 1.5 }],
    ["an invalid session ID", { ...scope, sessionId: "invalid" }],
  ])("rejects %s when creating a session", async (_label, invalidScope) => {
    await expect(
      createSessionCookie(actor, invalidScope, secret),
    ).rejects.toThrow("Application session scope is invalid.");
  });

  it.each([
    ["version", 1],
    ["instanceId", "instance\nwith-control"],
    ["sessionId", "not-an-opaque-session-id"],
    ["sessionGeneration", 0],
  ])("rejects a signed payload with invalid %s", async (field, value) => {
    const created = await createSessionCookie(actor, scope, secret, 1_000);
    const rewritten = await rewriteSignedPayload(created.cookie, (payload) => {
      payload[field] = value;
    });

    await expect(
      readApplicationSession(requestWithCookie(rewritten), secret, 2_000),
    ).resolves.toBeUndefined();
  });

  it("rejects signed payloads with unknown fields", async () => {
    const created = await createSessionCookie(actor, scope, secret, 1_000);
    const rewritten = await rewriteSignedPayload(created.cookie, (payload) => {
      payload["unexpected"] = true;
    });

    await expect(
      readApplicationSession(requestWithCookie(rewritten), secret, 2_000),
    ).resolves.toBeUndefined();
  });
});
