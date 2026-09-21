import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GameAssetSet } from "./assets/game-asset-set.js";
import { defaultGameAssetSet } from "./assets/sample-asset-sets.js";
import { BoardSurface } from "./board-surface.js";
import { GameAssetsProvider } from "./game-assets-provider.js";
import { GameIcon } from "./game-icon.js";
import { PlayerIcon } from "./player-icon.js";
import { Tile } from "./tile.js";

const emptyPack: GameAssetSet = {
  id: "empty",
  tiles: { faces: {} },
  board: {},
  players: {},
  icons: { winds: {}, actions: {} },
};

describe("game presentation", () => {
  it("retains labels, initials, content, and state when a pack omits art", () => {
    const markup = renderToStaticMarkup(
      <GameAssetsProvider assets={emptyPack}>
        <BoardSurface>
          <Tile
            kind={{ type: "suited", suit: "bamboo", rank: 2 }}
            selected
            highlighted
          />
          <Tile faceDown size="small" orientation="sideways" />
          <PlayerIcon displayName="Ada Player" kind="human" />
          <GameIcon kind="turn" />
          <p>Current turn</p>
        </BoardSurface>
      </GameAssetsProvider>,
    );
    expect(markup).toContain('aria-label="2 bamboo, selected, highlighted"');
    expect(markup).toContain('game-tile__label">2 bamboo');
    expect(markup).toContain('aria-label="Concealed tile"');
    expect(markup).toContain("game-tile--sideways");
    expect(markup).toContain('aria-label="Ada Player, human"');
    expect(markup).toContain("<span>AP</span>");
    expect(markup).toContain("Current turn");
    expect(markup).not.toContain("<img");
  });

  it("keeps image art decorative inside named tile and player semantics", () => {
    const markup = renderToStaticMarkup(
      <GameAssetsProvider assets={defaultGameAssetSet}>
        <Tile kind={{ type: "dragon", dragon: "red" }} />
        <PlayerIcon displayName="Computer" kind="bot" />
        <GameIcon kind="action" action="win" />
      </GameAssetsProvider>,
    );
    expect(markup).toContain('aria-label="red dragon"');
    expect(markup).toContain('aria-label="Computer, bot"');
    expect(markup.match(/alt="" aria-hidden="true"/gu)).toHaveLength(3);
    expect(markup).not.toContain("<button");
  });
});
