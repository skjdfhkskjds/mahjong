import {
  dragons,
  suitedRanks,
  suits,
  tileId,
  winds,
  type StandardTileKind,
  type Tile,
} from "@mahjong/game-core";

import { bonusTileKinds } from "../tiles/bonus-tile-kind.js";
import type { HongKongTileKind } from "../tiles/hong-kong-tile-kind.js";

function fourCopies(kind: StandardTileKind): readonly StandardTileKind[] {
  return [kind, kind, kind, kind];
}

function canonicalKinds(): readonly HongKongTileKind[] {
  const suited = suits.flatMap((suit) =>
    suitedRanks.flatMap((rank) => fourCopies({ type: "suited", suit, rank })),
  );
  const honorWinds = winds.flatMap((wind) =>
    fourCopies({ type: "wind", wind }),
  );
  const honorDragons = dragons.flatMap((dragon) =>
    fourCopies({ type: "dragon", dragon }),
  );

  return [...suited, ...honorWinds, ...honorDragons, ...bonusTileKinds];
}

export function createHongKongV1TileSet(): readonly Tile<HongKongTileKind>[] {
  return canonicalKinds().map((kind, index) => ({ id: tileId(index), kind }));
}
