import type { TileId } from "./tile-id.js";

export interface Tile<Kind> {
  readonly id: TileId;
  readonly kind: Kind;
}
