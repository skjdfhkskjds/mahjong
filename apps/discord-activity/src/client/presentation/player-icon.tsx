import type { Artwork } from "./assets/game-asset-set.js";
import { ArtworkImage } from "./artwork-image.js";
import { useGameAssets } from "./game-assets-provider.js";

export interface PlayerIconProps {
  readonly displayName: string;
  readonly kind: "human" | "bot";
  readonly avatar?: Artwork;
}

export function PlayerIcon({ displayName, kind, avatar }: PlayerIconProps) {
  const assets = useGameAssets();
  const initials =
    displayName
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() || (kind === "bot" ? "B" : "?");
  const defaultIcon = (
    <ArtworkImage
      artwork={assets.players[kind]}
      fallback={<span>{initials}</span>}
    />
  );
  return (
    <span
      className="player-icon"
      role="img"
      aria-label={`${displayName || "Unknown player"}, ${kind}`}
    >
      <span aria-hidden="true">
        {avatar === undefined ? (
          defaultIcon
        ) : (
          <ArtworkImage artwork={avatar} fallback={defaultIcon} />
        )}
      </span>
    </span>
  );
}
