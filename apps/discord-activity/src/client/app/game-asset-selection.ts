import { resolveGameAssetSet } from "../presentation/assets/game-asset-set.js";

/** Application-wide artwork selection. See docs/game-artwork.md for overrides. */
export const selectedGameAssets = resolveGameAssetSet();
