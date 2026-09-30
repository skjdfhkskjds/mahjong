import type { TableActor } from "../../adapters/transport/table-socket-status.js";

export interface PlayerIdentityDisplay {
  readonly displayName: string;
  readonly kind: "human" | "bot";
}

// Dedicated bots use a reserved actor namespace. Temporary autopilot is a
// separate seat state and must never change a human's displayed identity.
export function mapPlayerIdentity(actor: TableActor): PlayerIdentityDisplay {
  return {
    displayName: actor.displayName,
    kind: actor.id.startsWith("bot:") ? "bot" : "human",
  };
}
