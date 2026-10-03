import { createGameEngine } from "@mahjong/game-core";

import { hongKongPolicy } from "./hong-kong-policy.js";

/** The one shared runtime-free engine, composed with the frozen Hong Kong policy. */
export const hongKongGameEngine = createGameEngine(hongKongPolicy);
export type HongKongEngineResult = ReturnType<
  typeof hongKongGameEngine.automate
>;
