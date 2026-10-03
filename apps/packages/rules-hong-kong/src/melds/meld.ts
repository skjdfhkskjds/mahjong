import type { Seat, TileId } from "@mahjong/game-core";

export type MeldKind = "chow" | "pung" | "kong";
export type MeldExposure = "concealed" | "exposed";
export type KongKind = "added" | "concealed" | "exposed";

export interface DeclaredMeld {
  readonly exposure: MeldExposure;
  readonly id: string;
  readonly kind: MeldKind;
  readonly tileIds: readonly TileId[];
  readonly claimedTileId?: TileId;
  readonly kongKind?: KongKind;
  readonly sourceSeat?: Seat;
}

export function canonicalTileIds(
  tileIds: readonly TileId[],
): readonly TileId[] {
  return [...tileIds].sort((left, right) => Number(left) - Number(right));
}

export function meldStructuralSize(_meld: DeclaredMeld): 3 {
  void _meld;
  return 3;
}
