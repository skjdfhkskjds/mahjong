import {
  tileFaceKey,
  tileKindLabel,
  type TileKind,
} from "./assets/game-asset-set.js";
import { ArtworkImage } from "./artwork-image.js";
import { useGameAssets } from "./game-assets-provider.js";

export interface TileProps {
  readonly kind?: TileKind | undefined;
  readonly faceDown?: boolean;
  readonly size?: "small" | "medium";
  readonly orientation?: "upright" | "sideways";
  readonly selected?: boolean;
  readonly highlighted?: boolean;
}

/** Artwork only. The caller owns any button, command, selection, and disabled state. */
export function Tile({
  kind,
  faceDown = false,
  size = "medium",
  orientation = "upright",
  selected = false,
  highlighted = false,
}: TileProps) {
  const assets = useGameAssets();
  const label = faceDown
    ? "Concealed tile"
    : kind === undefined
      ? "Unknown tile"
      : tileKindLabel(kind);
  const artwork = faceDown
    ? assets.tiles.back
    : kind === undefined
      ? undefined
      : assets.tiles.faces[tileFaceKey(kind)];
  return (
    <span
      className={`game-tile game-tile--${size} game-tile--${orientation}${selected ? " game-tile--selected" : ""}${highlighted ? " game-tile--highlighted" : ""}`}
      role="img"
      aria-label={`${label}${selected ? ", selected" : ""}${highlighted ? ", highlighted" : ""}`}
    >
      <span className="game-tile__face" aria-hidden="true">
        <ArtworkImage
          artwork={artwork}
          fallback={<span className="game-tile__label">{label}</span>}
        />
      </span>
    </span>
  );
}
