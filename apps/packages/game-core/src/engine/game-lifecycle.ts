import { nextSeat, seats, type Seat } from "../table/seat.js";
import type { FlowTransition, GameLifecycle } from "./game-engine-contracts.js";

/** Turn-order responders, excluding the participant who opened the window. */
export function reactionResponderOrder(
  sourceSeat: Seat,
): readonly [Seat, Seat, Seat] {
  const first = nextSeat(sourceSeat);
  const second = nextSeat(first);
  return [first, second, nextSeat(second)];
}

export function assertLifecycle<Stage extends string>(
  lifecycle: GameLifecycle<Stage>,
): void {
  const { participants, activeSeat, phase } = lifecycle;
  if (
    participants.length !== seats.length ||
    new Set(participants.map(({ actorId }) => actorId)).size !== seats.length ||
    !participants.every(({ actorId }) => actorId.trim().length > 0) ||
    !seats.every(
      (seat) =>
        participants.filter((participant) => participant.seat === seat)
          .length === 1,
    ) ||
    !seats.includes(activeSeat)
  ) {
    throw new Error("Invalid game participants or active seat.");
  }
  if (phase.kind === "finished") return;
  const generation =
    phase.kind === "turn" ? phase.generation : phase.window.generation;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Invalid gameplay generation.");
  }
  if (phase.kind === "reaction") {
    const { id, responders, submitted } = phase.window;
    const sourceSeat = seats.find((seat) => !responders.includes(seat));
    if (
      id.trim().length === 0 ||
      responders.length !== seats.length - 1 ||
      new Set(responders).size !== responders.length ||
      !responders.every((seat) => seats.includes(seat)) ||
      sourceSeat === undefined ||
      responders.some(
        (seat, index) => seat !== reactionResponderOrder(sourceSeat)[index],
      ) ||
      new Set(submitted).size !== submitted.length ||
      !submitted.every((actorId) =>
        participants.some(
          (participant) =>
            participant.actorId === actorId &&
            responders.includes(participant.seat),
        ),
      )
    )
      throw new Error("Invalid reaction lifecycle.");
  }
}

export function transitionLifecycle<Stage extends string>(
  before: GameLifecycle<Stage>,
  transition: FlowTransition<Stage>,
): GameLifecycle<Stage> {
  const participants = before.participants;
  switch (transition.kind) {
    case "finished":
      return {
        participants,
        activeSeat: transition.seat,
        phase: { kind: "finished" },
      };
    case "turn": {
      const activeSeat =
        transition.next.kind === "retain"
          ? before.activeSeat
          : transition.next.kind === "advance"
            ? nextSeat(transition.next.from)
            : transition.next.seat;
      return {
        participants,
        activeSeat,
        phase: {
          kind: "turn",
          stage: transition.stage,
          generation: transition.generation,
        },
      };
    }
    case "reaction": {
      const first = nextSeat(transition.sourceSeat);
      return {
        participants,
        activeSeat:
          transition.active === "source" ? transition.sourceSeat : first,
        phase: {
          kind: "reaction",
          window: {
            id: transition.windowId,
            generation: transition.generation,
            responders: reactionResponderOrder(transition.sourceSeat),
            submitted: [],
          },
        },
      };
    }
  }
}

export function assertSameLifecycle<Stage extends string>(
  actual: GameLifecycle<Stage>,
  expected: GameLifecycle<Stage>,
): void {
  assertLifecycle(actual);
  assertLifecycle(expected);
  const participantsMatch = expected.participants.every((participant) =>
    actual.participants.some(
      (candidate) =>
        candidate.actorId === participant.actorId &&
        candidate.seat === participant.seat,
    ),
  );
  const a = actual.phase;
  const b = expected.phase;
  const phaseMatches =
    a.kind === "finished"
      ? b.kind === "finished"
      : a.kind === "turn"
        ? b.kind === "turn" &&
          a.stage === b.stage &&
          a.generation === b.generation
        : b.kind === "reaction" &&
          a.window.id === b.window.id &&
          a.window.generation === b.window.generation &&
          a.window.responders.length === b.window.responders.length &&
          a.window.responders.every(
            (seat, index) => seat === b.window.responders[index],
          ) &&
          a.window.submitted.length === b.window.submitted.length &&
          a.window.submitted.every((actor) =>
            b.window.submitted.includes(actor),
          );
  if (
    !participantsMatch ||
    actual.activeSeat !== expected.activeSeat ||
    !phaseMatches
  ) {
    throw new Error("Policy effects disagree with the gameplay transition.");
  }
}
