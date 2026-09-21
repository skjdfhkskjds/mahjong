import type { ActionIcon, Artwork, GameAssetSet } from "./game-asset-set.js";
import {
  TILE_KINDS,
  WINDS,
  tileFaceKey,
  type TileKind,
} from "./tile-artwork.js";

interface Palette {
  readonly id: string;
  readonly paper: string;
  readonly ink: string;
  readonly accent: string;
  readonly surface: string;
  readonly angular: boolean;
}

function svg(width: number, height: number, content: string): Artwork {
  return {
    src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">${content}</svg>`)}`,
    width,
    height,
    fit: "contain",
  };
}

function tileFace(kind: TileKind, palette: Palette): Artwork {
  const label =
    kind.type === "suited"
      ? kind.suit
      : kind.type === "bonus"
        ? kind.family
        : kind.type;
  const title =
    kind.type === "suited"
      ? String(kind.rank)
      : kind.type === "wind"
        ? kind.wind
        : kind.type === "dragon"
          ? kind.dragon
          : kind.name;
  const glyph =
    kind.type === "suited"
      ? kind.suit === "circles"
        ? "●"
        : kind.suit === "bamboo"
          ? "竹"
          : "萬"
      : kind.type === "wind"
        ? { east: "東", south: "南", west: "西", north: "北" }[kind.wind]
        : kind.type === "dragon"
          ? { red: "中", green: "發", white: "□" }[kind.dragon]
          : kind.family === "flower"
            ? "✿"
            : "❋";
  return svg(
    72,
    100,
    `<rect x="1" y="1" width="70" height="98" rx="${palette.angular ? "2" : "9"}" fill="${palette.paper}" stroke="${palette.accent}" stroke-width="2"/><path d="M8 10H64" stroke="${palette.accent}" stroke-width="4"/><text x="36" y="44" text-anchor="middle" font-family="sans-serif" font-size="27" fill="${palette.ink}">${glyph}</text><text x="36" y="67" text-anchor="middle" font-family="sans-serif" font-size="${title.length > 8 ? "9" : "12"}" font-weight="bold" fill="${palette.ink}">${title}</text><text x="36" y="86" text-anchor="middle" font-family="sans-serif" font-size="9" fill="${palette.ink}">${label}</text>`,
  );
}

function badge(content: string, palette: Palette): Artwork {
  return svg(
    48,
    48,
    `${palette.angular ? `<rect x="2" y="2" width="44" height="44" rx="6"` : `<circle cx="24" cy="24" r="22"`} fill="${palette.paper}" stroke="${palette.accent}" stroke-width="3"/><g fill="none" stroke="${palette.ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${content}</g>`,
  );
}

const actionPaths: Readonly<Record<ActionIcon, string>> = {
  draw: '<path d="M24 12V36M12 24H36"/>',
  discard: '<path d="M12 24H36M27 15L36 24L27 33"/>',
  win: '<path d="M12 14H36V24Q24 40 12 24ZM24 32V39M17 39H31"/>',
  chow: '<path d="M12 30V24M24 30V18M36 30V12"/>',
  pung: '<path d="M12 16V32M24 16V32M36 16V32"/>',
  kong: '<path d="M10 16V32M19 16V32M29 16V32M38 16V32"/>',
  pass: '<path d="M14 14L34 34M34 14L14 34"/>',
};

function createPack(palette: Palette): GameAssetSet {
  const faces: Partial<Record<ReturnType<typeof tileFaceKey>, Artwork>> = {};
  for (const kind of TILE_KINDS)
    faces[tileFaceKey(kind)] = tileFace(kind, palette);
  const winds: Partial<Record<(typeof WINDS)[number], Artwork>> = {};
  for (const wind of WINDS) {
    winds[wind] = badge(
      `<text x="24" y="31" text-anchor="middle" font-family="sans-serif" font-size="22" fill="${palette.ink}" stroke="none">${wind.slice(0, 1).toUpperCase()}</text>`,
      palette,
    );
  }
  const actions: Partial<Record<ActionIcon, Artwork>> = {};
  for (const action of [
    "draw",
    "discard",
    "win",
    "chow",
    "pung",
    "kong",
    "pass",
  ] as const) {
    actions[action] = badge(actionPaths[action], palette);
  }
  const ornament = palette.angular
    ? '<path d="M36 20L57 50L36 80L15 50Z"/>'
    : '<circle cx="36" cy="50" r="22"/><circle cx="36" cy="50" r="10"/>';
  return {
    id: palette.id,
    tiles: {
      faces,
      back: svg(
        72,
        100,
        `<rect x="1" y="1" width="70" height="98" rx="6" fill="${palette.surface}" stroke="${palette.accent}" stroke-width="2"/><g fill="none" stroke="${palette.accent}" stroke-width="3">${ornament}</g>`,
      ),
    },
    board: {
      surface: {
        ...svg(
          1200,
          800,
          `<defs><pattern id="weave" width="40" height="40" patternUnits="userSpaceOnUse"><path d="${palette.angular ? "M0 20L20 0L40 20L20 40Z" : "M0 0H40V40"}" fill="none" stroke="${palette.accent}" stroke-opacity=".12"/></pattern></defs><rect width="1200" height="800" fill="${palette.surface}"/><rect width="1200" height="800" fill="url(#weave)"/>`,
        ),
        fit: "cover",
      },
    },
    players: {
      human: badge(
        '<circle cx="24" cy="17" r="7"/><path d="M11 38C11 23 37 23 37 38"/>',
        palette,
      ),
      bot: badge(
        '<rect x="11" y="15" width="26" height="22" rx="3"/><path d="M24 9V15M18 23H19M29 23H30M19 30H29"/>',
        palette,
      ),
    },
    icons: {
      winds,
      turn: badge('<path d="M16 10L35 24L16 38Z"/>', palette),
      actions,
    },
  };
}

export const defaultGameAssetSet: GameAssetSet = createPack({
  id: "jade",
  paper: "#fff5dd",
  ink: "#163d36",
  accent: "#72b9a0",
  surface: "#143f35",
  angular: false,
});

export const sampleGameAssetSet: GameAssetSet = createPack({
  id: "midnight",
  paper: "#242947",
  ink: "#fff0d4",
  accent: "#ffac8a",
  surface: "#151a31",
  angular: true,
});
