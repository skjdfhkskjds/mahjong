/** Lifecycle data deliberately excludes application snapshots and receipts. */
export type SocketStatus =
  | { readonly state: "connecting"; readonly attempt: number }
  | { readonly state: "awaiting-snapshot"; readonly attempt: number }
  | {
      readonly state: "reconnecting";
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly state: "disconnecting"; readonly attempt: number }
  | { readonly state: "connected" }
  | { readonly state: "stopped" }
  | { readonly state: "authentication-required" }
  | { readonly state: "session-replaced" }
  | { readonly state: "protocol-error" }
  | { readonly state: "upgrade-required" };

export type SocketTransition =
  | { readonly type: "start" }
  | { readonly type: "open" }
  | { readonly type: "snapshot" }
  | { readonly type: "retry" }
  | { readonly type: "error" }
  | { readonly type: "close"; readonly code: number }
  | { readonly type: "session/replaced" }
  | { readonly type: "table/upgrade-required" }
  | { readonly type: "protocol-error" }
  | { readonly type: "stop" };

export function isSocketTerminal(status: SocketStatus): boolean {
  switch (status.state) {
    case "connecting":
    case "awaiting-snapshot":
    case "connected":
    case "reconnecting":
    case "disconnecting":
      return false;
    case "authentication-required":
    case "session-replaced":
    case "protocol-error":
    case "upgrade-required":
    case "stopped":
      return true;
    default:
      return assertNever(status);
  }
}

export function assertNever(value: never): never {
  throw new Error("Unsupported table socket transition.", { cause: value });
}

/** Effects and obsolete-connection guards live in the transport adapter. */
export function transitionSocket(
  status: SocketStatus,
  input: SocketTransition,
): SocketStatus {
  if (input.type === "start") {
    return { state: "connecting", attempt: 1 };
  }
  if (input.type === "stop") {
    return { state: "stopped" };
  }
  if (isSocketTerminal(status)) {
    return status;
  }

  switch (input.type) {
    case "open":
      return status.state === "connecting"
        ? { state: "awaiting-snapshot", attempt: status.attempt }
        : status;
    case "snapshot":
      return status.state === "awaiting-snapshot"
        ? { state: "connected" }
        : status;
    case "retry":
      return status.state === "reconnecting"
        ? { state: "connecting", attempt: status.attempt + 1 }
        : status;
    case "session/replaced":
      return { state: "session-replaced" };
    case "table/upgrade-required":
      return { state: "upgrade-required" };
    case "protocol-error":
      return { state: "protocol-error" };
    case "close":
      if (input.code === 4001) {
        return { state: "session-replaced" };
      }
      if (input.code === 4406) {
        return { state: "upgrade-required" };
      }
      if (input.code === 1008) {
        return { state: "authentication-required" };
      }
      return retryStatus(status);
    case "error":
      return status.state === "reconnecting"
        ? status
        : {
            state: "disconnecting",
            attempt: "attempt" in status ? status.attempt : 1,
          };
    default:
      return assertNever(input);
  }
}

function retryStatus(status: SocketStatus): SocketStatus {
  if (status.state === "reconnecting") {
    return status;
  }
  const attempt = "attempt" in status ? status.attempt : 1;
  return {
    state: "reconnecting",
    attempt,
    delayMs: Math.min(1_000 * 2 ** (attempt - 1), 15_000),
  };
}
