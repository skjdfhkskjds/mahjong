import type { ApplicationSeat } from "./table-command-application.js";
import type { TableSeat } from "./table-room-protocol.js";

export type BotSeatChange =
  | { readonly kind: "add"; readonly seat: ApplicationSeat }
  | { readonly kind: "remove"; readonly actorId: string };
export type BotSeatDecision =
  | { readonly kind: "accepted"; readonly change: BotSeatChange }
  | {
      readonly kind: "rejected";
      readonly error: { readonly code: string; readonly message: string };
    };

/** The owner chooses occupants; the storage adapter only applies these rows. */
export function prepareBotSeatChange(input: {
  readonly actorId: string;
  readonly ownerId: string | undefined;
  readonly seat: TableSeat;
  readonly command: "lobby/add-bot" | "lobby/remove-bot";
  readonly seats: readonly ApplicationSeat[];
  readonly botIds: ReadonlySet<string>;
  readonly newActorId: () => string;
}): BotSeatDecision {
  const reject = (code: string, message: string): BotSeatDecision => ({
    kind: "rejected",
    error: { code, message },
  });
  if (input.actorId !== input.ownerId)
    return reject("owner-required", "Only the table owner can manage bots.");
  if (!input.seats.some(({ actorId }) => actorId === input.actorId))
    return reject("owner-must-be-seated", "Claim a seat before managing bots.");
  const occupant = input.seats.find(({ seat }) => seat === input.seat);
  if (input.command === "lobby/remove-bot") {
    return occupant === undefined || !input.botIds.has(occupant.actorId)
      ? reject("bot-required", "That seat does not contain a bot.")
      : {
          kind: "accepted",
          change: { kind: "remove", actorId: occupant.actorId },
        };
  }
  if (occupant !== undefined || input.botIds.size >= 3)
    return reject("seat-unavailable", "Choose an empty seat for the bot.");
  return {
    kind: "accepted",
    change: {
      kind: "add",
      seat: {
        seat: input.seat,
        actorId: input.newActorId(),
        displayName: `Bot ${input.seat[0]?.toUpperCase() ?? ""}${input.seat.slice(1)}`,
        ready: true,
      },
    },
  };
}
