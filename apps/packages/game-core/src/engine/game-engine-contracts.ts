import type { Seat } from "../table/seat.js";
import type { NonEmptyReadonlyArray } from "./decision.js";

export interface GameParticipant {
  readonly actorId: string;
  readonly seat: Seat;
}

export interface ReactionLifecycle {
  readonly id: string;
  readonly generation: number;
  readonly responders: readonly Seat[];
  readonly submitted: readonly string[];
}

export interface GameLifecycle<Stage extends string> {
  readonly participants: readonly GameParticipant[];
  readonly activeSeat: Seat;
  readonly phase:
    | {
        readonly kind: "turn";
        readonly stage: Stage;
        readonly generation: number;
      }
    | { readonly kind: "reaction"; readonly window: ReactionLifecycle }
    | { readonly kind: "finished" };
}

export type FlowTransition<Stage extends string> =
  | {
      readonly kind: "turn";
      readonly stage: Stage;
      readonly generation: number;
      readonly next:
        | { readonly kind: "retain" }
        | { readonly kind: "advance"; readonly from: Seat }
        | { readonly kind: "select"; readonly seat: Seat };
    }
  | {
      readonly kind: "reaction";
      readonly windowId: string;
      readonly generation: number;
      readonly sourceSeat: Seat;
      readonly active: "source" | "next";
    }
  | { readonly kind: "finished"; readonly seat: Seat };

export type EngineErrorCode =
  | "spectator-cannot-play"
  | "game-ended"
  | "not-your-turn"
  | "reaction-in-progress"
  | "stale-reaction-window"
  | "not-a-responder"
  | "reaction-final"
  | "expiry-not-due"
  | "stale-expiry"
  | "no-automatic-move";

export interface GameRejection<Code extends string> {
  readonly kind: "rejected";
  readonly error: { readonly code: Code; readonly message: string };
}

export type PolicyDecision<
  Event,
  Stage extends string,
  MoveOutcome,
  Submission,
  ResolutionResult,
  Code extends string,
> =
  | GameRejection<Code>
  | {
      readonly kind: "applied";
      readonly events: NonEmptyReadonlyArray<Event>;
      readonly outcome: MoveOutcome;
      readonly transition: FlowTransition<Stage>;
    }
  | {
      readonly kind: "pending";
      readonly events: NonEmptyReadonlyArray<Event>;
      readonly submission: Submission;
      readonly windowId: string;
    }
  | {
      readonly kind: "completed";
      readonly events: NonEmptyReadonlyArray<Event>;
      readonly result: ResolutionResult;
      readonly transition: Extract<FlowTransition<Stage>, { kind: "finished" }>;
    };

export interface PolicyResolution<
  Event,
  Stage extends string,
  ResolutionResult,
> {
  readonly events: NonEmptyReadonlyArray<Event>;
  readonly result: ResolutionResult;
  readonly transition: Exclude<FlowTransition<Stage>, { kind: "reaction" }>;
}

export interface GamePolicy<
  State,
  Command,
  Event,
  Stage extends string,
  MoveOutcome,
  Submission,
  ResolutionResult,
  Code extends string,
> {
  readLifecycle(state: State): GameLifecycle<Stage>;
  classify(
    command: Command,
  ):
    | { readonly kind: "turn" }
    | { readonly kind: "reaction"; readonly windowId: string };
  evaluate(
    state: State,
    participant: GameParticipant,
    command: Command,
  ): PolicyDecision<
    Event,
    Stage,
    MoveOutcome,
    Submission,
    ResolutionResult,
    Code
  >;
  resolve(state: State): PolicyResolution<Event, Stage, ResolutionResult>;
  reduce(state: State, event: Event): State;
  automaticMove(state: State, participant: GameParticipant): Command | null;
}

export type ResolutionTrigger<Submission> =
  | { readonly kind: "move"; readonly actorId: string }
  | {
      readonly kind: "response";
      readonly actorId: string;
      readonly submission: Submission;
      readonly windowId: string;
    }
  | { readonly kind: "expiry"; readonly windowId: string };

interface AcceptedGameResult<State, Event, Stage extends string> {
  readonly state: State;
  readonly events: NonEmptyReadonlyArray<Event>;
  readonly lifecycle: GameLifecycle<Stage>;
}

export type GameResult<
  State,
  Event,
  Stage extends string,
  MoveOutcome,
  Submission,
  ResolutionResult,
  Code extends string,
> =
  | GameRejection<Code | EngineErrorCode>
  | (AcceptedGameResult<State, Event, Stage> & {
      readonly kind: "applied";
      readonly outcome: MoveOutcome;
      readonly visibility: "public";
    })
  | (AcceptedGameResult<State, Event, Stage> & {
      readonly kind: "pending";
      readonly submission: Submission;
      readonly windowId: string;
      readonly visibility: "private";
    })
  | (AcceptedGameResult<State, Event, Stage> & {
      readonly kind: "resolved";
      readonly result: ResolutionResult;
      readonly trigger: ResolutionTrigger<Submission>;
      readonly visibility: "public";
    });

/** An accepted single move, preserving its own effects and semantic payload. */
export type GameStep<
  State,
  Event,
  Stage extends string,
  MoveOutcome,
  Submission,
  ResolutionResult,
> = Exclude<
  GameResult<
    State,
    Event,
    Stage,
    MoveOutcome,
    Submission,
    ResolutionResult,
    never
  >,
  GameRejection<string>
>;

export type GameAutomationResult<
  State,
  Event,
  Stage extends string,
  MoveOutcome,
  Submission,
  ResolutionResult,
  Code extends string,
> =
  | GameResult<
      State,
      Event,
      Stage,
      MoveOutcome,
      Submission,
      ResolutionResult,
      Code
    >
  | (AcceptedGameResult<State, Event, Stage> & {
      readonly kind: "automated";
      readonly visibility: "public";
      readonly steps: readonly [
        GameStep<
          State,
          Event,
          Stage,
          MoveOutcome,
          Submission,
          ResolutionResult
        >,
        GameStep<
          State,
          Event,
          Stage,
          MoveOutcome,
          Submission,
          ResolutionResult
        >,
        ...GameStep<
          State,
          Event,
          Stage,
          MoveOutcome,
          Submission,
          ResolutionResult
        >[],
      ];
    });

export type DeadlineTarget<Stage extends string> =
  | {
      readonly kind: "turn";
      readonly generation: number;
      readonly stage: Stage;
      readonly seat: Seat;
    }
  | {
      readonly kind: "reaction";
      readonly generation: number;
      readonly windowId: string;
    };

export interface LogicalDeadline<Stage extends string> {
  readonly target: DeadlineTarget<Stage>;
  readonly dueAt: number;
}

export interface GameEngine<
  State,
  Command,
  Event,
  Stage extends string,
  MoveOutcome,
  Submission,
  ResolutionResult,
  Code extends string,
> {
  lifecycle(state: State): GameLifecycle<Stage>;
  execute(
    state: State,
    actorId: string,
    command: Command,
  ): GameResult<
    State,
    Event,
    Stage,
    MoveOutcome,
    Submission,
    ResolutionResult,
    Code
  >;
  automate(
    state: State,
    actorId: string,
  ): GameAutomationResult<
    State,
    Event,
    Stage,
    MoveOutcome,
    Submission,
    ResolutionResult,
    Code
  >;
  deadlineTarget(state: State): DeadlineTarget<Stage> | null;
  expire(
    state: State,
    deadline: LogicalDeadline<Stage>,
    now: number,
  ): GameAutomationResult<
    State,
    Event,
    Stage,
    MoveOutcome,
    Submission,
    ResolutionResult,
    Code
  >;
}
