import { describe, expect, it } from "vitest";

import {
  expireTableGame,
  startTableGame,
  tableGameActorAt,
  tableGameDeadline,
  tableGameDeadlineMatches,
  tableGameEngine,
} from "../../src/worker/durable-objects/table-room/table-room-game-engine.js";
import type { PendingDeadline } from "../../src/worker/durable-objects/table-room/deadline-queue.js";

function initialState() {
  return startTableGame(
    {
      east: "stable:east",
      south: "stable:south",
      west: "stable:west",
      north: "stable:north",
    },
    Uint8Array.from({ length: 1_028 }, (_, index) => (index * 41 + 17) & 0xff),
  ).state;
}

function pendingDeadline(
  state: ReturnType<typeof initialState>,
  dueAt: number,
): PendingDeadline {
  const target = tableGameDeadline(state);
  if (target === null) throw new Error("Expected an active deadline.");
  return {
    deadlineId: target.deadlineId,
    dueAt,
    kind: target.kind,
    payload: target.payload,
    status: "pending",
    targetGeneration: target.targetGeneration,
  };
}

function openReaction() {
  const initial = initialState();
  const lifecycle = tableGameEngine.lifecycle(initial);
  const discarded = tableGameEngine.automate(
    initial,
    tableGameActorAt(initial, lifecycle.activeSeat),
  );
  if (discarded.kind === "rejected") throw new Error(discarded.error.message);
  if (discarded.lifecycle.phase.kind !== "reaction")
    throw new Error("Expected an open reaction window.");
  return discarded;
}

describe("TableRoom engine composition", () => {
  it("retains legacy operational targets and delivers the half-open expiry boundary", () => {
    const state = initialState();
    const deadline = pendingDeadline(state, 1_000);
    expect(deadline).toMatchObject({
      deadlineId: `turn:${String(state.sequence)}`,
      targetGeneration: state.sequence,
      payload: {
        type: "system/turn-expired",
        openingSequence: state.sequence,
        phase: "awaiting-dealer-discard",
        seat: state.turn,
      },
    });
    expect(expireTableGame(state, deadline, 999)).toMatchObject({
      kind: "rejected",
      error: { code: "expiry-not-due" },
    });
    const expired = expireTableGame(state, deadline, 1_000);
    expect(expired.kind).toBe("applied");
    if (expired.kind === "rejected") throw new Error(expired.error.message);
    expect(expired.lifecycle.phase.kind).toBe("reaction");
    expect(expireTableGame(expired.state, deadline, 1_000)).toMatchObject({
      kind: "rejected",
      error: { code: "stale-expiry" },
    });
  });

  it("keeps a private response on the same reaction deadline and publishes only resolution", () => {
    const opened = openReaction();
    const phase = opened.lifecycle.phase;
    if (phase.kind !== "reaction")
      throw new Error("Expected reaction lifecycle.");
    const deadline = pendingDeadline(opened.state, 8_000);
    expect(deadline).toMatchObject({
      deadlineId: `reaction:${String(phase.window.generation)}`,
      payload: {
        type: "system/reaction-expired",
        openingSequence: phase.window.generation,
        windowId: phase.window.id,
      },
    });
    const firstSeat = phase.window.responders[0];
    if (firstSeat === undefined) throw new Error("Expected a responder.");
    const firstActor = tableGameActorAt(opened.state, firstSeat);
    const pending = tableGameEngine.automate(opened.state, firstActor);
    if (pending.kind === "rejected") throw new Error(pending.error.message);
    expect(pending.kind).toBe("pending");
    expect(pending.visibility).toBe("private");
    if (deadline.payload.type !== "system/reaction-expired")
      throw new Error("Expected reaction deadline.");
    expect(tableGameDeadlineMatches(pending.state, deadline.payload)).toBe(
      true,
    );
    expect(tableGameDeadline(pending.state)).toEqual(
      tableGameDeadline(opened.state),
    );
    let resolved = pending;
    const events = [...pending.events];
    for (const seat of phase.window.responders.slice(1)) {
      const response = tableGameEngine.execute(
        resolved.state,
        tableGameActorAt(opened.state, seat),
        {
          type: "game/react",
          windowId: phase.window.id,
          response: { type: "pass" },
        },
      );
      if (response.kind === "rejected") throw new Error(response.error.message);
      resolved = response;
      events.push(...response.events);
    }
    expect(resolved.visibility).toBe("public");
    expect(tableGameEngine.lifecycle(resolved.state).phase).toMatchObject({
      kind: "turn",
      stage: "awaiting-draw",
    });
    expect(
      events.filter(({ type }) => type === "game/reaction-intent-submitted"),
    ).toHaveLength(3);
    expect(tableGameDeadlineMatches(resolved.state, deadline.payload)).toBe(
      false,
    );
  });

  it("expires a reaction through the engine and keeps automated draw/discard atomic", () => {
    const opened = openReaction();
    const expired = expireTableGame(
      opened.state,
      pendingDeadline(opened.state, 8_000),
      8_000,
    );
    if (expired.kind === "rejected") throw new Error(expired.error.message);
    expect(expired.kind).toBe("resolved");
    expect(expired.visibility).toBe("public");
    const turnDeadline = pendingDeadline(expired.state, 68_000);
    const automaticTurn = expireTableGame(expired.state, turnDeadline, 68_000);
    if (automaticTurn.kind === "rejected")
      throw new Error(automaticTurn.error.message);
    expect(automaticTurn.lifecycle.phase.kind).toBe("reaction");
    expect(automaticTurn.events.map(({ type }) => type)).toContain(
      "game/turn-drawn",
    );
    expect(automaticTurn.events.map(({ type }) => type)).toContain(
      "game/discard-reaction-opened",
    );
  });
});
