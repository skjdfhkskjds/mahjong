import { useState, type ReactNode } from "react";

import type { Artwork } from "./assets/game-asset-set.js";

function LoadedArtwork({
  artwork,
  fallback,
}: {
  readonly artwork: Artwork;
  readonly fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      alt=""
      aria-hidden="true"
      className="game-artwork"
      draggable={false}
      height={artwork.height}
      onError={() => {
        setFailed(true);
      }}
      src={artwork.src}
      style={{
        objectFit:
          artwork.fit === "stretch" ? "fill" : (artwork.fit ?? "contain"),
      }}
      width={artwork.width}
    />
  );
}

/** The source key lets a replacement asset recover after the previous URL failed. */
export function ArtworkImage({
  artwork,
  fallback,
}: {
  readonly artwork: Artwork | undefined;
  readonly fallback: ReactNode;
}) {
  if (artwork === undefined) return fallback;
  return (
    <LoadedArtwork key={artwork.src} artwork={artwork} fallback={fallback} />
  );
}
