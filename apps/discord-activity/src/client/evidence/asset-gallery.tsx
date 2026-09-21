import { BoardSurface } from "../presentation/board-surface.js";
import { GameIcon } from "../presentation/game-icon.js";
import { PlayerIcon } from "../presentation/player-icon.js";
import { Tile } from "../presentation/tile.js";
import { TILE_KINDS } from "../presentation/assets/tile-artwork.js";

/** Only composed by the development-only viewer evidence page. */
export function AssetGallery() {
  return (
    <section className="panel" aria-label="Artwork evidence">
      <h2>Artwork evidence</h2>
      <BoardSurface>
        <div className="player-heading">
          <PlayerIcon displayName="Human example" kind="human" />
          <PlayerIcon displayName="Bot example" kind="bot" />
          <GameIcon kind="wind" wind="east" /> East
          <GameIcon kind="turn" /> Current turn
          <GameIcon kind="action" action="draw" /> Draw
        </div>
        <ul className="public-tiles" aria-label="Every tile artwork">
          {TILE_KINDS.map((kind, index) => (
            <li key={index}>
              <Tile kind={kind} />
            </li>
          ))}
          <li>
            <Tile faceDown />
          </li>
          <li>
            <Tile
              kind={{ type: "wind", wind: "east" }}
              orientation="sideways"
              selected
              highlighted
            />
          </li>
        </ul>
      </BoardSurface>
    </section>
  );
}
