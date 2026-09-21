import type { ActionIcon, Wind } from "./assets/game-asset-set.js";
import { ArtworkImage } from "./artwork-image.js";
import { useGameAssets } from "./game-assets-provider.js";

export type GameIconProps =
  | { readonly kind: "wind"; readonly wind: Wind }
  | { readonly kind: "turn" }
  | { readonly kind: "action"; readonly action: ActionIcon };

/** Always accompanies a visible text label supplied by the layout. */
export function GameIcon(props: GameIconProps) {
  const { icons } = useGameAssets();
  const artwork =
    props.kind === "wind"
      ? icons.winds[props.wind]
      : props.kind === "turn"
        ? icons.turn
        : icons.actions[props.action];
  return (
    <span className="game-icon" aria-hidden="true">
      <ArtworkImage artwork={artwork} fallback={null} />
    </span>
  );
}
