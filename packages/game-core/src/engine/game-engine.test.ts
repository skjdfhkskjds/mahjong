import { describe, expect, it, vi } from "vitest";

import { seat, seats } from "../table/seat.js";
import type { GameLifecycle, GamePolicy } from "./game-engine-contracts.js";
import { createGameEngine } from "./game-engine.js";

type Stage = "draw" | "discard";
interface State {
  readonly flow: GameLifecycle<Stage>;
  readonly trace: readonly string[];
}
type Command =
  | { readonly kind: "draw" | "discard" | "win" | "illegal" }
  | {
      readonly kind: "respond";
      readonly windowId: string;
      readonly claim: "pass" | "win";
    };
type Event =
  | { readonly kind: "draw" | "discard" | "finish" | "resolve" }
  | { readonly kind: "respond"; readonly actorId: string };
type Policy = GamePolicy<
  State,
  Command,
  Event,
  Stage,
  "drawn" | "discarded",
  "pass" | "win",
  "won" | "all-pass",
  "illegal-move"
>;

function initial(): State {
  return {
    flow: {
      participants: seats.map((seat) => ({ seat, actorId: seat })),
      activeSeat: seat("east"),
      phase: { kind: "turn", stage: "draw", generation: 0 },
    },
    trace: [],
  };
}

function policy(): Policy {
  return {
    readLifecycle: (state) => state.flow,
    classify: (command) =>
      command.kind === "respond"
        ? { kind: "reaction", windowId: command.windowId }
        : { kind: "turn" },
    evaluate: (_state, participant, command) => {
      switch (command.kind) {
        case "illegal":
          return {
            kind: "rejected",
            error: {
              code: "illegal-move",
              message: "The policy rejects this move.",
            },
          };
        case "draw":
          return {
            kind: "applied",
            events: [{ kind: "draw" }],
            outcome: "drawn",
            transition: {
              kind: "turn",
              stage: "discard",
              generation: 1,
              next: { kind: "retain" },
            },
          };
        case "discard":
          return {
            kind: "applied",
            events: [{ kind: "discard" }],
            outcome: "discarded",
            transition: {
              kind: "reaction",
              windowId: "window",
              generation: 2,
              sourceSeat: participant.seat,
              active: "next",
            },
          };
        case "win":
          return {
            kind: "completed",
            events: [{ kind: "finish" }],
            result: "won",
            transition: { kind: "finished", seat: participant.seat },
          };
        case "respond":
          return {
            kind: "pending",
            events: [{ kind: "respond", actorId: participant.actorId }],
            submission: command.claim,
            windowId: command.windowId,
          };
      }
    },
    resolve: () => ({
      events: [{ kind: "resolve" }],
      result: "all-pass",
      transition: {
        kind: "turn",
        stage: "draw",
        generation: 3,
        next: { kind: "advance", from: seat("east") },
      },
    }),
    reduce: (state, event) => {
      const flow = state.flow;
      const trace = [...state.trace, event.kind];
      switch (event.kind) {
        case "draw":
          return {
            trace,
            flow: {
              ...flow,
              phase: { kind: "turn", stage: "discard", generation: 1 },
            },
          };
        case "discard":
          return {
            trace,
            flow: {
              ...flow,
              activeSeat: seat("south"),
              phase: {
                kind: "reaction",
                window: {
                  id: "window",
                  generation: 2,
                  responders: [seat("south"), seat("west"), seat("north")],
                  submitted: [],
                },
              },
            },
          };
        case "finish":
          return { trace, flow: { ...flow, phase: { kind: "finished" } } };
        case "resolve":
          return {
            trace,
            flow: {
              ...flow,
              activeSeat: seat("south"),
              phase: { kind: "turn", stage: "draw", generation: 3 },
            },
          };
        case "respond": {
          if (flow.phase.kind !== "reaction")
            throw new Error("Test response requires a window.");
          return {
            trace,
            flow: {
              ...flow,
              phase: {
                kind: "reaction",
                window: {
                  ...flow.phase.window,
                  submitted: [...flow.phase.window.submitted, event.actorId],
                },
              },
            },
          };
        }
      }
    },
    automaticMove: (state) =>
      state.flow.phase.kind === "reaction"
        ? {
            kind: "respond",
            windowId: state.flow.phase.window.id,
            claim: "pass",
          }
        : state.flow.phase.kind === "turn"
          ? { kind: state.flow.phase.stage }
          : null,
  };
}

function openWindow(): State {
  const result = createGameEngine(policy()).execute(initial(), "east", {
    kind: "discard",
  });
  if (result.kind === "rejected") throw new Error("Test setup failed.");
  return result.state;
}

const pass = { kind: "respond", windowId: "window", claim: "pass" } as const;

describe("shared gameplay engine", () => {
  it("gates participants and active turns before evaluating policy legality", () => {
    const rules = policy();
    const evaluate = vi.spyOn(rules, "evaluate");
    const engine = createGameEngine(rules);
    expect(
      engine.execute(initial(), "visitor", { kind: "draw" }),
    ).toMatchObject({
      kind: "rejected",
      error: { code: "spectator-cannot-play" },
    });
    expect(engine.execute(initial(), "south", { kind: "draw" })).toMatchObject({
      kind: "rejected",
      error: { code: "not-your-turn" },
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(
      engine.execute(initial(), "east", { kind: "illegal" }),
    ).toMatchObject({ kind: "rejected", error: { code: "illegal-move" } });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("applies ordered policy effects while retaining the active participant", () => {
    const engine = createGameEngine(policy());
    expect(engine.execute(initial(), "east", { kind: "draw" })).toMatchObject({
      kind: "applied",
      outcome: "drawn",
      visibility: "public",
      state: { trace: ["draw"] },
      lifecycle: {
        activeSeat: "east",
        phase: { kind: "turn", stage: "discard" },
      },
    });
  });

  it("returns immediate completion explicitly and removes its deadline", () => {
    const engine = createGameEngine(policy());
    const result = engine.execute(initial(), "east", { kind: "win" });
    expect(result).toMatchObject({
      kind: "resolved",
      result: "won",
      trigger: { kind: "move", actorId: "east" },
      lifecycle: { phase: { kind: "finished" } },
    });
    if (result.kind === "rejected") throw new Error("Expected completion.");
    expect(engine.deadlineTarget(result.state)).toBeNull();
    expect(
      engine.execute(result.state, "east", { kind: "draw" }),
    ).toMatchObject({ error: { code: "game-ended" } });
  });

  it("opens ordered responders and rejects stale, source, and ordinary moves", () => {
    const state = openWindow();
    const engine = createGameEngine(policy());
    expect(engine.lifecycle(state).phase).toMatchObject({
      kind: "reaction",
      window: { responders: ["south", "west", "north"] },
    });
    expect(
      engine.execute(state, "south", { ...pass, windowId: "old" }),
    ).toMatchObject({ error: { code: "stale-reaction-window" } });
    expect(engine.execute(state, "east", pass)).toMatchObject({
      error: { code: "not-a-responder" },
    });
    expect(engine.execute(state, "south", { kind: "draw" })).toMatchObject({
      error: { code: "reaction-in-progress" },
    });
  });

  it("records a legal win privately without finalizing it and makes its response final", () => {
    const engine = createGameEngine(policy());
    const state = openWindow();
    const result = engine.execute(state, "south", { ...pass, claim: "win" });
    expect(result).toMatchObject({
      kind: "pending",
      submission: "win",
      windowId: "window",
      visibility: "private",
    });
    expect(result).not.toHaveProperty("result");
    if (result.kind === "rejected") throw new Error("Expected submission.");
    expect(engine.deadlineTarget(result.state)).toEqual(
      engine.deadlineTarget(state),
    );
    expect(engine.execute(result.state, "south", pass)).toMatchObject({
      error: { code: "reaction-final" },
    });
  });

  it("resolves once on the final response with intent before resolution", () => {
    const rules = policy();
    const resolve = vi.spyOn(rules, "resolve");
    const engine = createGameEngine(rules);
    let state = openWindow();
    for (const actor of ["south", "west"]) {
      const result = engine.execute(state, actor, pass);
      if (result.kind !== "pending")
        throw new Error("Expected private response.");
      state = result.state;
    }
    expect(resolve).not.toHaveBeenCalled();
    const result = engine.execute(state, "north", pass);
    expect(result).toMatchObject({
      kind: "resolved",
      result: "all-pass",
      visibility: "public",
      trigger: {
        kind: "response",
        actorId: "north",
        submission: "pass",
        windowId: "window",
      },
      events: [{ kind: "respond", actorId: "north" }, { kind: "resolve" }],
      lifecycle: {
        activeSeat: "south",
        phase: { kind: "turn", stage: "draw" },
      },
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    if (result.kind === "rejected") throw new Error("Expected resolution.");
    expect(engine.execute(result.state, "north", pass)).toMatchObject({
      error: { code: "stale-reaction-window" },
    });
  });

  it("rejects malformed participant assignments", () => {
    const state = initial();
    const engine = createGameEngine(policy());
    expect(() =>
      engine.lifecycle({
        ...state,
        flow: { ...state.flow, participants: state.flow.participants.slice(1) },
      }),
    ).toThrow("Invalid game participants");
    expect(() =>
      engine.lifecycle({
        ...state,
        flow: {
          ...state.flow,
          participants: state.flow.participants.map((participant) => ({
            ...participant,
            actorId: "duplicate",
          })),
        },
      }),
    ).toThrow("Invalid game participants");
  });

  it.each([
    { responders: [seat("north"), seat("west"), seat("south")], submitted: [] },
    {
      responders: [seat("south"), seat("south"), seat("north")],
      submitted: [],
    },
    {
      responders: [seat("south"), seat("west"), seat("north")],
      submitted: ["south", "south"],
    },
    {
      responders: [seat("south"), seat("west"), seat("north")],
      submitted: ["visitor"],
    },
    {
      responders: [seat("south"), seat("west"), seat("north")],
      submitted: ["east"],
    },
  ])("rejects malformed restored reaction membership and order", (window) => {
    const state = openWindow();
    const engine = createGameEngine(policy());
    expect(() =>
      engine.lifecycle({
        ...state,
        flow: {
          ...state.flow,
          phase: {
            kind: "reaction",
            window: { id: "window", generation: 2, ...window },
          },
        },
      }),
    ).toThrow("Invalid reaction lifecycle");
  });

  it("fails closed when effects disagree with the declared flow", () => {
    const rules = policy();
    const engine = createGameEngine({
      ...rules,
      reduce: (state: State) => state,
    });
    expect(() => engine.execute(initial(), "east", { kind: "draw" })).toThrow(
      "Policy effects disagree",
    );
  });

  it("rejects a policy bypass of shared reaction submission", () => {
    const rules = policy();
    const engine = createGameEngine({
      ...rules,
      evaluate: (() => ({
        kind: "completed",
        events: [{ kind: "finish" }],
        result: "won",
        transition: { kind: "finished", seat: seat("south") },
      })) satisfies Policy["evaluate"],
    });
    expect(() => engine.execute(openWindow(), "south", pass)).toThrow(
      "A reaction must be recorded",
    );
  });
});

describe("explicit logical deadlines and automation", () => {
  it.each([99, 100, 101])("enforces the reaction due boundary at %s", (now) => {
    const engine = createGameEngine(policy());
    const state = openWindow();
    const target = engine.deadlineTarget(state);
    if (target === null) throw new Error("Expected deadline.");
    const result = engine.expire(state, { target, dueAt: 100 }, now);
    expect(result).toMatchObject(
      now < 100
        ? { kind: "rejected", error: { code: "expiry-not-due" } }
        : {
            kind: "resolved",
            trigger: { kind: "expiry", windowId: "window" },
            result: "all-pass",
          },
    );
    if (result.kind !== "rejected")
      expect(
        engine.expire(result.state, { target, dueAt: 100 }, now),
      ).toMatchObject({ error: { code: "stale-expiry" } });
  });

  it("rejects stale generation, window, stage, and seat targets", () => {
    const engine = createGameEngine(policy());
    const state = initial();
    for (const target of [
      { kind: "turn", stage: "draw", seat: seat("east"), generation: 1 },
      { kind: "turn", stage: "discard", seat: seat("east"), generation: 0 },
      { kind: "turn", stage: "draw", seat: seat("south"), generation: 0 },
      { kind: "reaction", windowId: "window", generation: 0 },
    ] as const)
      expect(engine.expire(state, { target, dueAt: 0 }, 100)).toMatchObject({
        error: { code: "stale-expiry" },
      });
  });

  it.each([Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid explicit time %s",
    (time) => {
      const engine = createGameEngine(policy());
      const state = initial();
      const target = engine.deadlineTarget(state);
      if (target === null) throw new Error("Expected deadline.");
      expect(() => engine.expire(state, { target, dueAt: 100 }, time)).toThrow(
        RangeError,
      );
      expect(() => engine.expire(state, { target, dueAt: time }, 100)).toThrow(
        RangeError,
      );
    },
  );

  it("runs timeout draw and discard through the same evaluation pipeline", () => {
    const rules = policy();
    const evaluate = vi.spyOn(rules, "evaluate");
    const engine = createGameEngine(rules);
    const state = initial();
    const target = engine.deadlineTarget(state);
    if (target === null) throw new Error("Expected deadline.");
    expect(engine.expire(state, { target, dueAt: 100 }, 100)).toMatchObject({
      kind: "automated",
      steps: [
        { kind: "applied", outcome: "drawn", events: [{ kind: "draw" }] },
        {
          kind: "applied",
          outcome: "discarded",
          events: [{ kind: "discard" }],
        },
      ],
      events: [{ kind: "draw" }, { kind: "discard" }],
      state: { trace: ["draw", "discard"] },
      lifecycle: { phase: { kind: "reaction" } },
    });
    expect(evaluate).toHaveBeenCalledTimes(2);
    const result = engine.automate(state, "east");
    if (result.kind !== "automated")
      throw new Error("Expected compound automation.");
    expect(result.events).toEqual(result.steps.flatMap((step) => step.events));
    expect(result.state).toEqual(result.steps.at(-1)?.state);
    expect(result.lifecycle).toEqual(result.steps.at(-1)?.lifecycle);
    expect(result.steps[0].state.trace).toEqual(["draw"]);
  });

  it("automates a reaction only once without advancing the new active turn", () => {
    const engine = createGameEngine(policy());
    const first = engine.automate(openWindow(), "south");
    expect(first).toMatchObject({
      kind: "pending",
      submission: "pass",
      visibility: "private",
      events: [{ kind: "respond", actorId: "south" }],
    });
    if (first.kind === "rejected") throw new Error("Expected response.");
    expect(engine.automate(first.state, "south")).toMatchObject({
      error: { code: "reaction-final" },
    });
  });

  it("rejects absent automatic moves and fails a repeated turn stage", () => {
    const rules = policy();
    expect(
      createGameEngine({ ...rules, automaticMove: () => null }).automate(
        initial(),
        "east",
      ),
    ).toMatchObject({ error: { code: "no-automatic-move" } });
    const engine = createGameEngine({
      ...rules,
      automaticMove: (): Command => ({ kind: "draw" }),
    });
    expect(() => engine.automate(initial(), "east")).toThrow(
      "Automatic move did not advance",
    );
  });
});
