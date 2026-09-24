import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startTableSocketHeartbeat,
  TABLE_HEARTBEAT_REQUEST,
} from "./table-socket-heartbeat.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function heartbeat() {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  const send = vi.fn();
  const onTimeout = vi.fn();
  const control = startTableSocketHeartbeat({
    send,
    onTimeout,
    scheduler: {
      now: () => performance.now(),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => {
        window.clearTimeout(timer);
      },
    },
  });
  return { control, send, onTimeout };
}

describe("negotiated table heartbeats", () => {
  it("expires a late ACK even if a suspended timer callback has not run", () => {
    let now = 0;
    const callbacks: (() => void)[] = [];
    const send = vi.fn();
    const onTimeout = vi.fn();
    const clearTimeout = vi.fn();
    const control = startTableSocketHeartbeat({
      send,
      onTimeout,
      scheduler: {
        now: () => now,
        setTimeout: (callback) => callbacks.push(callback),
        clearTimeout,
      },
    });
    callbacks[0]?.();
    expect(send).toHaveBeenCalledTimes(1);
    now = 15_000;
    control.acknowledge();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    for (const callback of callbacks) callback();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("sends every five seconds without extending the oldest unanswered deadline", () => {
    const { send, onTimeout } = heartbeat();
    vi.advanceTimersByTime(14_999);
    expect(send.mock.calls).toEqual([
      [TABLE_HEARTBEAT_REQUEST],
      [TABLE_HEARTBEAT_REQUEST],
      [TABLE_HEARTBEAT_REQUEST],
    ]);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an ACK only for pending work and gives the next ping its own deadline", () => {
    const { control, send, onTimeout } = heartbeat();
    control.acknowledge();
    vi.advanceTimersByTime(4_000);
    control.acknowledge();
    vi.advanceTimersByTime(500);
    control.acknowledge();
    vi.advanceTimersByTime(15_499);
    expect(send).toHaveBeenCalledTimes(4);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    control.acknowledge();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels both timers on stop and ignores late ACKs", () => {
    const { control, send, onTimeout } = heartbeat();
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(2);
    control.stop();
    control.stop();
    control.acknowledge();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("retires a failed send once and clears every scheduled callback", () => {
    const { send, onTimeout } = heartbeat();
    send.mockImplementation(() => {
      throw new Error("closed");
    });
    vi.advanceTimersByTime(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reschedule when sending synchronously closes the socket", () => {
    const { control, send, onTimeout } = heartbeat();
    send.mockImplementation(() => {
      control.stop();
    });
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
