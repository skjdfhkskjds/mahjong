import { describe, expect, it } from "vitest";

import {
  createSessionCookie,
  readApplicationSession,
} from "../../src/worker/auth/application-session.js";

const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
const actor = { displayName: "East Player", id: "mock:east" } as const;

function requestWithCookie(setCookie: string): Request {
  return new Request("https://activity.example/api/session", {
    headers: { Cookie: setCookie.split(";", 1)[0] ?? "" },
  });
}

describe("application session boundary", () => {
  it("round-trips a signed, short-lived session", async () => {
    const created = await createSessionCookie(actor, secret, 1_000, {
      mode: "discord",
    });
    expect(created.cookie).toContain(
      "Secure; HttpOnly; SameSite=None; Partitioned",
    );
    await expect(
      readApplicationSession(requestWithCookie(created.cookie), secret, 2_000),
    ).resolves.toEqual(created.session);
  });

  it("rejects an expired or modified token", async () => {
    const created = await createSessionCookie(actor, secret, 1_000);
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
    await expect(createSessionCookie(actor, "too-short")).rejects.toThrow(
      TypeError,
    );
  });

  it("verifies a rotated previous signing key and retains CSRF state", async () => {
    const previous = `${secret}-previous`;
    const created = await createSessionCookie(actor, previous, 1_000);
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
  });
});
