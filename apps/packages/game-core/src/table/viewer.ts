import type { PlayerId } from "../identity/identifiers.js";

export type Viewer =
  | {
      readonly type: "player";
      readonly playerId: PlayerId;
    }
  | {
      readonly type: "spectator";
    };
