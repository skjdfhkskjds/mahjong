// Transport-only capability v1; mirrored at the Worker boundary without cross-importing.
export const TABLE_HEARTBEAT_REQUEST = "table/heartbeat/1";
export const TABLE_HEARTBEAT_RESPONSE = "table/heartbeat-ack/1";
export const TABLE_HEARTBEAT_READY = "table/heartbeat-ready/1";
export const TABLE_HEARTBEAT_INTERVAL_MS = 5_000;
export const TABLE_HEARTBEAT_TIMEOUT_MS = 15_000;

interface HeartbeatScheduler {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => number;
  readonly clearTimeout: (timer: number) => void;
}

export interface TableSocketHeartbeat {
  acknowledge(): void;
  stop(): void;
}

/** One deadline covers all unanswered pings; additional pings cannot extend it. */
export function startTableSocketHeartbeat(input: {
  readonly send: (frame: string) => void;
  readonly onTimeout: () => void;
  readonly scheduler: HeartbeatScheduler;
}): TableSocketHeartbeat {
  let stopped = false;
  const isStopped = (): boolean => stopped;
  let sendTimer: number | undefined;
  let deadlineTimer: number | undefined;
  let deadlineAt: number | undefined;
  const stop = (): void => {
    stopped = true;
    if (sendTimer !== undefined) input.scheduler.clearTimeout(sendTimer);
    if (deadlineTimer !== undefined)
      input.scheduler.clearTimeout(deadlineTimer);
    sendTimer = undefined;
    deadlineTimer = undefined;
    deadlineAt = undefined;
  };
  const timeout = (): void => {
    if (stopped) return;
    stop();
    input.onTimeout();
  };
  const send = (): void => {
    if (isStopped()) return;
    if (deadlineAt !== undefined && input.scheduler.now() >= deadlineAt) {
      timeout();
      return;
    }
    deadlineAt ??= input.scheduler.now() + TABLE_HEARTBEAT_TIMEOUT_MS;
    deadlineTimer ??= input.scheduler.setTimeout(
      timeout,
      TABLE_HEARTBEAT_TIMEOUT_MS,
    );
    try {
      input.send(TABLE_HEARTBEAT_REQUEST);
    } catch {
      timeout();
      return;
    }
    // Sending can synchronously close the socket and stop this loop.
    if (isStopped()) return;
    sendTimer = input.scheduler.setTimeout(send, TABLE_HEARTBEAT_INTERVAL_MS);
  };
  // Defer the first ping until the caller has installed this heartbeat instance.
  sendTimer = input.scheduler.setTimeout(send, 0);
  return {
    acknowledge: () => {
      if (stopped || deadlineTimer === undefined) return;
      if (deadlineAt !== undefined && input.scheduler.now() >= deadlineAt) {
        timeout();
        return;
      }
      input.scheduler.clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      deadlineAt = undefined;
    },
    stop,
  };
}
