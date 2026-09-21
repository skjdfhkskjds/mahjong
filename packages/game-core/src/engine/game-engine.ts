import type { NonEmptyReadonlyArray } from "./decision.js";
import type {
  DeadlineTarget,
  EngineErrorCode,
  GameEngine,
  GameAutomationResult,
  GameLifecycle,
  GamePolicy,
  GameRejection,
  GameResult,
  ResolutionTrigger,
} from "./game-engine-contracts.js";
import {
  assertLifecycle,
  assertSameLifecycle,
  transitionLifecycle,
} from "./game-lifecycle.js";

const rejectionMessages: Readonly<Record<EngineErrorCode, string>> = {
  "spectator-cannot-play": "Only a seated player can act.",
  "game-ended": "The hand has ended.",
  "not-your-turn": "Another player has the turn.",
  "reaction-in-progress": "The current reaction window must resolve first.",
  "stale-reaction-window": "That reaction window is not open.",
  "not-a-responder": "This seat cannot respond to the action.",
  "reaction-final": "The first valid response is final.",
  "expiry-not-due": "The gameplay deadline is not due.",
  "stale-expiry": "That gameplay deadline is no longer current.",
  "no-automatic-move": "There is no automatic move available.",
};

function reject(code: EngineErrorCode): GameRejection<EngineErrorCode> {
  return {
    kind: "rejected",
    error: { code, message: rejectionMessages[code] },
  };
}

function sameTarget<Stage extends string>(
  current: DeadlineTarget<Stage> | null,
  target: DeadlineTarget<Stage>,
): boolean {
  if (current?.generation !== target.generation) return false;
  return current.kind === "turn"
    ? target.kind === "turn" &&
        current.stage === target.stage &&
        current.seat === target.seat
    : target.kind === "reaction" && current.windowId === target.windowId;
}

export function createGameEngine<
  State,
  Command,
  Event,
  Stage extends string,
  MoveOutcome,
  Submission,
  ResolutionResult,
  Code extends string,
>(
  policy: GamePolicy<
    State,
    Command,
    Event,
    Stage,
    MoveOutcome,
    Submission,
    ResolutionResult,
    Code
  >,
): GameEngine<
  State,
  Command,
  Event,
  Stage,
  MoveOutcome,
  Submission,
  ResolutionResult,
  Code
> {
  type Result = GameResult<
    State,
    Event,
    Stage,
    MoveOutcome,
    Submission,
    ResolutionResult,
    Code
  >;

  type AutomationResult = GameAutomationResult<
    State,
    Event,
    Stage,
    MoveOutcome,
    Submission,
    ResolutionResult,
    Code
  >;

  function lifecycle(state: State): GameLifecycle<Stage> {
    const value = policy.readLifecycle(state);
    assertLifecycle(value);
    return value;
  }

  function apply(
    state: State,
    events: NonEmptyReadonlyArray<Event>,
    expected: GameLifecycle<Stage>,
  ): State {
    if (events.length === 0)
      throw new Error("An accepted move requires effects.");
    const updated = events.reduce(
      (current, event) => policy.reduce(current, event),
      state,
    );
    assertSameLifecycle(policy.readLifecycle(updated), expected);
    return updated;
  }

  function resolve(
    state: State,
    before: GameLifecycle<Stage>,
    trigger: ResolutionTrigger<Submission>,
    preceding: readonly Event[] = [],
  ): Result {
    const decision = policy.resolve(state);
    const expected = transitionLifecycle(before, decision.transition);
    const updated = apply(state, decision.events, expected);
    const events: NonEmptyReadonlyArray<Event> = [
      decision.events[0],
      ...decision.events.slice(1),
    ];
    // A last response precedes the resolution events in the same atomic batch.
    if (preceding.length > 0) {
      const first = preceding[0];
      if (first === undefined)
        throw new Error("Missing preceding gameplay effect.");
      return {
        kind: "resolved",
        state: updated,
        events: [first, ...preceding.slice(1), ...events],
        result: decision.result,
        trigger,
        lifecycle: expected,
        visibility: "public",
      };
    }
    return {
      kind: "resolved",
      state: updated,
      events,
      result: decision.result,
      trigger,
      lifecycle: expected,
      visibility: "public",
    };
  }

  function execute(state: State, actorId: string, command: Command): Result {
    const before = lifecycle(state);
    const participant = before.participants.find(
      (entry) => entry.actorId === actorId,
    );
    if (participant === undefined) return reject("spectator-cannot-play");
    if (before.phase.kind === "finished") return reject("game-ended");
    const classification = policy.classify(command);
    if (classification.kind === "turn") {
      if (before.phase.kind === "reaction")
        return reject("reaction-in-progress");
      if (participant.seat !== before.activeSeat)
        return reject("not-your-turn");
    } else {
      if (
        before.phase.kind !== "reaction" ||
        before.phase.window.id !== classification.windowId
      )
        return reject("stale-reaction-window");
      if (!before.phase.window.responders.includes(participant.seat))
        return reject("not-a-responder");
      if (before.phase.window.submitted.includes(actorId))
        return reject("reaction-final");
    }
    const decision = policy.evaluate(state, participant, command);
    if (decision.kind === "rejected") return decision;
    if (decision.kind === "pending") {
      if (
        classification.kind !== "reaction" ||
        before.phase.kind !== "reaction" ||
        decision.windowId !== before.phase.window.id
      )
        throw new Error(
          "Policy submitted outside the current reaction window.",
        );
      const window = {
        ...before.phase.window,
        submitted: [...before.phase.window.submitted, actorId],
      };
      const expected: GameLifecycle<Stage> = {
        ...before,
        phase: { kind: "reaction", window },
      };
      const updated = apply(state, decision.events, expected);
      if (window.submitted.length === window.responders.length)
        return resolve(
          updated,
          expected,
          {
            kind: "response",
            actorId,
            submission: decision.submission,
            windowId: window.id,
          },
          decision.events,
        );
      return {
        kind: "pending",
        state: updated,
        events: decision.events,
        submission: decision.submission,
        windowId: window.id,
        lifecycle: expected,
        visibility: "private",
      };
    }
    if (classification.kind !== "turn")
      throw new Error("A reaction must be recorded before resolution.");
    const expected = transitionLifecycle(before, decision.transition);
    const updated = apply(state, decision.events, expected);
    if (decision.kind === "completed")
      return {
        kind: "resolved",
        state: updated,
        events: decision.events,
        result: decision.result,
        trigger: { kind: "move", actorId },
        lifecycle: expected,
        visibility: "public",
      };
    return {
      kind: "applied",
      state: updated,
      events: decision.events,
      outcome: decision.outcome,
      lifecycle: expected,
      visibility: "public",
    };
  }

  function automate(state: State, actorId: string): AutomationResult {
    const before = lifecycle(state);
    const participant = before.participants.find(
      (entry) => entry.actorId === actorId,
    );
    if (participant === undefined) return reject("spectator-cannot-play");
    if (before.phase.kind === "finished") return reject("game-ended");
    if (before.phase.kind === "turn" && before.activeSeat !== participant.seat)
      return reject("not-your-turn");
    let current = state;
    let accepted: Exclude<AutomationResult, GameRejection<string>> | null =
      null;
    const visitedStages = new Set<Stage>();
    for (;;) {
      const flow = lifecycle(current);
      if (flow.phase.kind === "turn") {
        // Ordinary automation can visit each stage only once, preventing a policy
        // from looping indefinitely while allowing the existing draw/discard pair.
        if (visitedStages.has(flow.phase.stage))
          throw new Error("Automatic move did not advance the turn stage.");
        visitedStages.add(flow.phase.stage);
      }
      const command = policy.automaticMove(current, participant);
      if (command === null) return accepted ?? reject("no-automatic-move");
      const result = execute(current, actorId, command);
      if (result.kind === "rejected") {
        if (accepted !== null)
          throw new Error("Automatic continuation was rejected.");
        return result;
      }
      accepted =
        accepted === null
          ? result
          : {
              kind: "automated",
              state: result.state,
              events: [...accepted.events, ...result.events],
              lifecycle: result.lifecycle,
              visibility: "public",
              steps:
                accepted.kind === "automated"
                  ? [...accepted.steps, result]
                  : [accepted, result],
            };
      current = result.state;
      if (
        before.phase.kind === "reaction" ||
        result.lifecycle.phase.kind !== "turn" ||
        result.lifecycle.activeSeat !== participant.seat
      )
        return accepted;
    }
  }

  function deadlineTarget(state: State): DeadlineTarget<Stage> | null {
    const { phase, activeSeat } = lifecycle(state);
    switch (phase.kind) {
      case "finished":
        return null;
      case "turn":
        return {
          kind: "turn",
          generation: phase.generation,
          stage: phase.stage,
          seat: activeSeat,
        };
      case "reaction":
        return {
          kind: "reaction",
          generation: phase.window.generation,
          windowId: phase.window.id,
        };
    }
  }

  return {
    lifecycle,
    execute,
    automate,
    deadlineTarget,
    expire(state, deadline, now): AutomationResult {
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !Number.isSafeInteger(deadline.dueAt) ||
        deadline.dueAt < 0
      )
        throw new RangeError(
          "Logical expiry requires non-negative safe integer times.",
        );
      if (!sameTarget(deadlineTarget(state), deadline.target))
        return reject("stale-expiry");
      if (now < deadline.dueAt) return reject("expiry-not-due");
      const before = lifecycle(state);
      if (before.phase.kind === "reaction")
        return resolve(state, before, {
          kind: "expiry",
          windowId: before.phase.window.id,
        });
      const participant = before.participants.find(
        (entry) => entry.seat === before.activeSeat,
      );
      if (participant === undefined)
        throw new Error("Active game participant is missing.");
      return automate(state, participant.actorId);
    },
  };
}
