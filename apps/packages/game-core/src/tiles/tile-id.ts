import type { Brand } from "../identity/brand.js";

export type TileId = Brand<number, "TileId">;

export function tileId(value: number): TileId {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("TileId must be a non-negative safe integer.");
  }

  return value as TileId;
}
