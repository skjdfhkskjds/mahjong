import { describe, expect, it } from "vitest";

import {
  deadlineRaceOrder,
  deadlineTargetsCurrent,
  planDeadlineCompletion,
  prepareDeadlineCompletion,
  type DeadlineCompletionReader,
  type DeadlineCompletionState,
  type PendingDeadline,
  type PreparedDeadlineCompletion,
} from "./table-deadline-application.js";

const deadline: PendingDeadline = {
  deadlineId: "reaction:12",
  dueAt: 1_000,
  kind: "reaction",
  payload: {
    openingSequence: 12,
    type: "system/reaction-expired",
    windowId: "window:12",
  },
  status: "pending",
  targetGeneration: 12,
};

class TestDeadlineStore implements DeadlineCompletionReader {
  state: DeadlineCompletionState = {
    deadline: { ...deadline, processedAt: null },
    receipt: undefined,
  };

  readDeadlineCompletion(deadlineId: string): DeadlineCompletionState {
    expect(deadlineId).toBe(deadline.deadlineId);
    return this.state;
  }

  commit(completion: PreparedDeadlineCompletion): void {
    this.state = {
      deadline:
        completion.deadline.status === "cancelled"
          ? completion.deadline
          : {
              ...completion.deadline,
              status: "processed",
              processedAt: completion.receipt.processedAt,
            },
      receipt: completion.receipt,
    };
  }
}

describe("table deadline application", () => {
  it("applies exactly at the half-open boundary and replays the stored result", () => {
    const store = new TestDeadlineStore();
    expect(deadlineRaceOrder(999, deadline.dueAt)).toBe("user-first");
    expect(() =>
      planDeadlineCompletion(store, deadline.deadlineId, 999),
    ).toThrow("before its deadline");
    expect(deadlineRaceOrder(1_000, deadline.dueAt)).toBe("deadline-first");
    const plan = planDeadlineCompletion(store, deadline.deadlineId, 1_000);
    expect(plan.type).toBe("apply");
    if (plan.type !== "apply") throw new Error("Expected due work.");
    const prepared = prepareDeadlineCompletion(plan.deadline, 1_000, {
      outcome: "processed",
      publicTransition: false,
    });
    expect(prepared.receipt.requestJson).toBe(
      '{"command":{"openingSequence":12,"type":"system/reaction-expired","windowId":"window:12"},"commandId":"reaction:12","targetGeneration":12,"type":"table/system-command","version":1}',
    );
    expect(prepared.receipt.resultJson).toBe(
      '{"outcome":"processed","publicTransition":false}',
    );
    store.commit(prepared);
    expect(planDeadlineCompletion(store, deadline.deadlineId, 2_000)).toEqual({
      type: "replayed",
      receipt: prepared.receipt,
    });
  });

  it("uses current cancellation instead of a previously selected pending row", () => {
    const store = new TestDeadlineStore();
    store.state = {
      deadline: { ...deadline, status: "cancelled", processedAt: null },
      receipt: undefined,
    };
    const plan = planDeadlineCompletion(store, deadline.deadlineId, 1_000);
    expect(plan.type).toBe("complete");
    if (plan.type !== "complete")
      throw new Error("Expected cancelled completion.");
    expect(plan.completion.receipt.result).toEqual({
      outcome: "no-op",
      reason: "cancelled",
    });
    store.commit(plan.completion);
    expect(store.state.deadline?.status).toBe("cancelled");
    expect(store.state.deadline?.processedAt).toBeNull();
    expect(planDeadlineCompletion(store, deadline.deadlineId, 2_000)).toEqual({
      type: "replayed",
      receipt: plan.completion.receipt,
    });
  });

  it("preserves an application-decided stale target as an idempotent no-op", () => {
    const store = new TestDeadlineStore();
    const plan = planDeadlineCompletion(store, deadline.deadlineId, 1_000);
    if (plan.type !== "apply") throw new Error("Expected due work.");
    expect(
      deadlineTargetsCurrent(plan.deadline, {
        kind: "reaction",
        openingSequence: 13,
        targetGeneration: 13,
        windowId: "window:13",
      }),
    ).toBe(false);
    const prepared = prepareDeadlineCompletion(plan.deadline, 1_000, {
      outcome: "no-op",
      reason: "stale-target",
    });
    store.commit(prepared);
    expect(planDeadlineCompletion(store, deadline.deadlineId, 2_000)).toEqual({
      type: "replayed",
      receipt: prepared.receipt,
    });
  });

  it("rejects missing work, missing receipts, and divergent completed timestamps", () => {
    const store = new TestDeadlineStore();
    store.state = { deadline: undefined, receipt: undefined };
    expect(() =>
      planDeadlineCompletion(store, deadline.deadlineId, 1_000),
    ).toThrow("missing or completed");
    store.state = {
      deadline: { ...deadline, status: "processed", processedAt: 1_000 },
      receipt: undefined,
    };
    expect(() =>
      planDeadlineCompletion(store, deadline.deadlineId, 1_000),
    ).toThrow("missing or completed");
    const prepared = prepareDeadlineCompletion(deadline, 1_000, {
      outcome: "processed",
      publicTransition: true,
    });
    store.commit(prepared);
    store.state = {
      ...store.state,
      deadline: { ...deadline, status: "processed", processedAt: 1_001 },
    };
    expect(() =>
      planDeadlineCompletion(store, deadline.deadlineId, 2_000),
    ).toThrow("diverges");
  });

  it("does not allow a pending command to claim a cancelled result", () => {
    expect(() =>
      prepareDeadlineCompletion(deadline, 1_000, {
        outcome: "no-op",
        reason: "cancelled",
      }),
    ).toThrow("Only a cancelled");
    expect(() =>
      prepareDeadlineCompletion(
        { ...deadline, status: "cancelled", processedAt: null },
        1_000,
        { outcome: "processed", publicTransition: false },
      ),
    ).toThrow("Only a cancelled");
    expect(() =>
      prepareDeadlineCompletion(deadline, 999, {
        outcome: "processed",
        publicTransition: false,
      }),
    ).toThrow("before its deadline");
  });
});
