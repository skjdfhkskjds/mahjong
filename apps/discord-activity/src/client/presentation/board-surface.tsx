import type { ReactNode } from "react";

import { ArtworkImage } from "./artwork-image.js";
import { useGameAssets } from "./game-assets-provider.js";

export function BoardSurface({ children }: { readonly children: ReactNode }) {
  const assets = useGameAssets();
  return (
    <div className="board-surface">
      <div className="board-surface__art" aria-hidden="true">
        <ArtworkImage artwork={assets.board.surface} fallback={null} />
      </div>
      <div className="board-surface__content">{children}</div>
    </div>
  );
}
