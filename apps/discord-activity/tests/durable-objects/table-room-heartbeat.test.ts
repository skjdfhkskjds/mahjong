import { describe, expect, it } from "vitest";

import { heartbeatPresenceExpiresAt } from "../../src/worker/durable-objects/table-room/table-room-heartbeat.js";

describe("table heartbeat liveness evidence", () => {
  it("starts the timeout at acceptance until the platform observes a heartbeat", () => {
    expect(
      heartbeatPresenceExpiresAt({
        acceptedAt: 1_000,
        sessionExpiresAt: 100_000,
      }),
    ).toBe(16_000);
    expect(
      heartbeatPresenceExpiresAt({
        acceptedAt: 1_000,
        lastHeartbeatAt: 6_000,
        sessionExpiresAt: 100_000,
      }),
    ).toBe(21_000);
  });

  it("never extends authority beyond session expiry or reuses older acceptance evidence", () => {
    expect(
      heartbeatPresenceExpiresAt({
        acceptedAt: 1_000,
        lastHeartbeatAt: 6_000,
        sessionExpiresAt: 10_000,
      }),
    ).toBe(10_000);
    expect(
      heartbeatPresenceExpiresAt({
        acceptedAt: 6_000,
        lastHeartbeatAt: 1_000,
        sessionExpiresAt: 100_000,
      }),
    ).toBe(21_000);
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid timestamp %s", (value) => {
    for (const field of ["acceptedAt", "lastHeartbeatAt", "sessionExpiresAt"]) {
      expect(() =>
        heartbeatPresenceExpiresAt({
          acceptedAt: 1_000,
          sessionExpiresAt: 100_000,
          [field]: value,
        }),
      ).toThrow("Invalid table heartbeat timestamps");
    }
  });
});
