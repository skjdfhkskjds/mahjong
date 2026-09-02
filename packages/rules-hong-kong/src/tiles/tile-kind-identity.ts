import type { TileId } from "@mahjong/game-core";

import type { HongKongTileKind } from "./hong-kong-tile-kind.js";
import { createHongKongV1TileSet } from "../wall/create-tile-set.js";

const inventory = createHongKongV1TileSet();
const tilesById = new Map(inventory.map((tile) => [tile.id, tile]));

export function tileKind(id: TileId): HongKongTileKind {
  const kind = tilesById.get(id)?.kind;
  if (kind === undefined) throw new RangeError("Unknown physical tile ID.");
  return kind;
}

export function tileKindKey(id: TileId): string {
  const kind = tileKind(id);
  if (kind.type === "suited") return `s:${kind.suit}:${String(kind.rank)}`;
  if (kind.type === "wind") return `w:${kind.wind}`;
  if (kind.type === "dragon") return `d:${kind.dragon}`;
  return `b:${kind.family}:${String(kind.number)}`;
}

export function sameTileKind(left: TileId, right: TileId): boolean {
  return tileKindKey(left) === tileKindKey(right);
}

export function isBonusTile(id: TileId): boolean {
  return tileKind(id).type === "bonus";
}
