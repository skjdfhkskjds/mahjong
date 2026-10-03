export const suits = ["characters", "circles", "bamboo"] as const;
export type Suit = (typeof suits)[number];

export const suitedRanks = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type SuitedRank = (typeof suitedRanks)[number];

export const winds = ["east", "south", "west", "north"] as const;
export type Wind = (typeof winds)[number];

export const dragons = ["red", "green", "white"] as const;
export type Dragon = (typeof dragons)[number];

export interface SuitedTileKind {
  readonly type: "suited";
  readonly suit: Suit;
  readonly rank: SuitedRank;
}

export interface WindTileKind {
  readonly type: "wind";
  readonly wind: Wind;
}

export interface DragonTileKind {
  readonly type: "dragon";
  readonly dragon: Dragon;
}

export type StandardTileKind = SuitedTileKind | WindTileKind | DragonTileKind;
