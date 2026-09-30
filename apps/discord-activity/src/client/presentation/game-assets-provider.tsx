import { createContext, useContext, type ReactNode } from "react";

import type { GameAssetSet } from "./assets/game-asset-set.js";

const GameAssetsContext = createContext<GameAssetSet | undefined>(undefined);

export function GameAssetsProvider({
  assets,
  children,
}: {
  readonly assets: GameAssetSet;
  readonly children: ReactNode;
}) {
  return (
    <GameAssetsContext.Provider value={assets}>
      {children}
    </GameAssetsContext.Provider>
  );
}

export function useGameAssets(): GameAssetSet {
  const assets = useContext(GameAssetsContext);
  if (assets === undefined) {
    throw new Error("Game artwork requires a GameAssetsProvider.");
  }
  return assets;
}
