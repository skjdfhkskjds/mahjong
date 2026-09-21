import {
  tableGameEngine,
  type TableGameTransition,
} from "./table-room-game-engine.js";

/** Application controller selection stays outside the rules engine. */
export function appendAutomaticReactionPasses(
  transition: TableGameTransition,
  automatedActorIds: ReadonlySet<string>,
): TableGameTransition {
  let current = transition;
  for (;;) {
    const lifecycle = tableGameEngine.lifecycle(current.state);
    if (lifecycle.phase.kind !== "reaction") return current;
    const { window } = lifecycle.phase;
    const responder = window.responders
      .map(
        (seat) =>
          lifecycle.participants.find((player) => player.seat === seat)
            ?.actorId,
      )
      .find(
        (actorId) =>
          actorId !== undefined &&
          automatedActorIds.has(actorId) &&
          !window.submitted.includes(actorId),
      );
    if (responder === undefined) return current;
    const pass = tableGameEngine.automate(current.state, responder);
    if (pass.kind === "rejected")
      throw new Error("Automatic reaction pass was rejected.");
    current = {
      state: pass.state,
      events: [current.events[0], ...current.events.slice(1), ...pass.events],
      visibility:
        current.visibility === "public" || pass.visibility === "public"
          ? "public"
          : "private",
    };
  }
}
