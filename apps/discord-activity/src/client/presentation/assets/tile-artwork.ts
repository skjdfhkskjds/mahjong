import type { HongKongTileKind } from "@mahjong/rules-hong-kong";

type SuitedKind = Extract<HongKongTileKind, { readonly type: "suited" }>;
type WindKind = Extract<HongKongTileKind, { readonly type: "wind" }>;
type DragonKind = Extract<HongKongTileKind, { readonly type: "dragon" }>;
type BonusKind = Extract<HongKongTileKind, { readonly type: "bonus" }>;

export type Wind = WindKind["wind"];
export type TileKind =
  | SuitedKind
  | WindKind
  | DragonKind
  | Pick<
      Extract<BonusKind, { readonly family: "flower" }>,
      "type" | "family" | "name"
    >
  | Pick<
      Extract<BonusKind, { readonly family: "season" }>,
      "type" | "family" | "name"
    >;

export type TileFaceKey =
  | `suited:${SuitedKind["suit"]}:${SuitedKind["rank"]}`
  | `wind:${Wind}`
  | `dragon:${DragonKind["dragon"]}`
  | `bonus:flower:${Extract<BonusKind, { readonly family: "flower" }>["name"]}`
  | `bonus:season:${Extract<BonusKind, { readonly family: "season" }>["name"]}`;

const suits = ["characters", "circles", "bamboo"] as const;
const ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const rankKeys = {
  1: "1",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
} as const;
export const WINDS = ["east", "south", "west", "north"] as const;
const dragons = ["red", "green", "white"] as const;
const flowers = ["plum", "orchid", "chrysanthemum", "bamboo"] as const;
const seasons = ["spring", "summer", "autumn", "winter"] as const;

export const TILE_KINDS: readonly TileKind[] = [
  ...suits.flatMap((suit) =>
    ranks.map((rank): TileKind => ({ type: "suited", suit, rank })),
  ),
  ...WINDS.map((wind): TileKind => ({ type: "wind", wind })),
  ...dragons.map((dragon): TileKind => ({ type: "dragon", dragon })),
  ...flowers.map((name): TileKind => ({
    type: "bonus",
    family: "flower",
    name,
  })),
  ...seasons.map((name): TileKind => ({
    type: "bonus",
    family: "season",
    name,
  })),
];

/** Select only artwork-relevant fields from an already viewer-visible kind. */
export function presentationTileKind(
  kind: Readonly<Record<string, unknown>>,
): TileKind | undefined {
  return TILE_KINDS.find((candidate) => {
    if (candidate.type !== kind["type"]) return false;
    switch (candidate.type) {
      case "suited":
        return (
          candidate.suit === kind["suit"] && candidate.rank === kind["rank"]
        );
      case "wind":
        return candidate.wind === kind["wind"];
      case "dragon":
        return candidate.dragon === kind["dragon"];
      case "bonus":
        return (
          candidate.family === kind["family"] && candidate.name === kind["name"]
        );
    }
  });
}

export function tileFaceKey(kind: TileKind): TileFaceKey {
  switch (kind.type) {
    case "suited":
      return `suited:${kind.suit}:${rankKeys[kind.rank]}`;
    case "wind":
      return `wind:${kind.wind}`;
    case "dragon":
      return `dragon:${kind.dragon}`;
    case "bonus":
      return kind.family === "flower"
        ? `bonus:flower:${kind.name}`
        : `bonus:season:${kind.name}`;
  }
}

export function tileKindLabel(kind: TileKind): string {
  switch (kind.type) {
    case "suited":
      return `${String(kind.rank)} ${kind.suit}`;
    case "wind":
      return `${kind.wind} wind`;
    case "dragon":
      return `${kind.dragon} dragon`;
    case "bonus":
      return `${kind.name} ${kind.family}`;
  }
}
