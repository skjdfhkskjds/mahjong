import { defaultGameAssetSet } from "./sample-asset-sets.js";
import type { TileFaceKey, Wind } from "./tile-artwork.js";

export {
  presentationTileKind,
  tileFaceKey,
  tileKindLabel,
} from "./tile-artwork.js";
export type { TileFaceKey, TileKind, Wind } from "./tile-artwork.js";

/** Intrinsic pixel dimensions also define the aspect ratio for SVG artwork. */
export interface Artwork {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly fit?: "contain" | "cover" | "stretch";
}

export const ACTION_ICONS = [
  "draw",
  "discard",
  "win",
  "chow",
  "pung",
  "kong",
  "pass",
] as const;
export type ActionIcon = (typeof ACTION_ICONS)[number];

export interface GameAssetSet {
  readonly id: string;
  readonly tiles: {
    readonly faces: Readonly<Partial<Record<TileFaceKey, Artwork>>>;
    readonly back?: Artwork;
  };
  readonly board: { readonly surface?: Artwork };
  readonly players: { readonly human?: Artwork; readonly bot?: Artwork };
  readonly icons: {
    readonly winds: Readonly<Partial<Record<Wind, Artwork>>>;
    readonly turn?: Artwork;
    readonly actions: Readonly<Partial<Record<ActionIcon, Artwork>>>;
  };
}

export interface GameAssetOverrides {
  readonly tiles?: Partial<GameAssetSet["tiles"]>;
  readonly board?: GameAssetSet["board"];
  readonly players?: GameAssetSet["players"];
  readonly icons?: Partial<GameAssetSet["icons"]>;
}

export interface GameAssetSelection {
  readonly set?: GameAssetSet;
  readonly overrides?: GameAssetOverrides;
}

/** Resolve once at composition; a replacement pack is never filled with default art. */
export function resolveGameAssetSet({
  set = defaultGameAssetSet,
  overrides = {},
}: GameAssetSelection = {}): GameAssetSet {
  return {
    id: set.id,
    tiles: {
      ...set.tiles,
      ...overrides.tiles,
      faces: { ...set.tiles.faces, ...overrides.tiles?.faces },
    },
    board: { ...set.board, ...overrides.board },
    players: { ...set.players, ...overrides.players },
    icons: {
      ...set.icons,
      ...overrides.icons,
      winds: { ...set.icons.winds, ...overrides.icons?.winds },
      actions: { ...set.icons.actions, ...overrides.icons?.actions },
    },
  };
}
