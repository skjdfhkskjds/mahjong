// Transport-only capability v1; mirrored at the client boundary without cross-importing.
export const TABLE_HEARTBEAT_REQUEST = "table/heartbeat/1";
export const TABLE_HEARTBEAT_RESPONSE = "table/heartbeat-ack/1";
export const TABLE_HEARTBEAT_READY = "table/heartbeat-ready/1";
export const TABLE_HEARTBEAT_INTERVAL_MS = 5_000;
export const TABLE_HEARTBEAT_TIMEOUT_MS = 15_000;

/** Platform auto-response timestamps are liveness evidence, never game activity. */
export function heartbeatPresenceExpiresAt(input: {
  readonly acceptedAt: number;
  readonly lastHeartbeatAt?: number;
  readonly sessionExpiresAt: number;
}): number {
  if (
    !Number.isSafeInteger(input.acceptedAt) ||
    input.acceptedAt < 0 ||
    !Number.isSafeInteger(input.sessionExpiresAt) ||
    input.sessionExpiresAt < 0 ||
    (input.lastHeartbeatAt !== undefined &&
      (!Number.isSafeInteger(input.lastHeartbeatAt) ||
        input.lastHeartbeatAt < 0))
  ) {
    throw new Error("Invalid table heartbeat timestamps.");
  }
  const observedAt = Math.max(
    input.acceptedAt,
    input.lastHeartbeatAt ?? input.acceptedAt,
  );
  return Math.min(
    input.sessionExpiresAt,
    observedAt + TABLE_HEARTBEAT_TIMEOUT_MS,
  );
}
