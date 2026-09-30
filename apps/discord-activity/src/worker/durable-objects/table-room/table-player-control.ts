/** Stable player identity is independent of the currently active controller. */
export interface PlayerControl {
  readonly actorId: string;
  readonly kind: "HUMAN" | "BOT";
  readonly controller: "HUMAN" | "BOT";
  readonly generation: number;
}
