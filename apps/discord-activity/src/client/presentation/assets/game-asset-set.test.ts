import { describe, expect, it } from "vitest";

import {
  ACTION_ICONS,
  presentationTileKind,
  resolveGameAssetSet,
  tileFaceKey,
  tileKindLabel,
  type Artwork,
  type GameAssetSet,
} from "./game-asset-set.js";
import {
  defaultGameAssetSet,
  sampleGameAssetSet,
} from "./sample-asset-sets.js";
import { TILE_KINDS, WINDS } from "./tile-artwork.js";

const custom: Artwork = { src: "/custom.png", width: 144, height: 200 };

describe("game asset selection", () => {
  it("supplies every face and integrated category in both distinct local packs", () => {
    expect(TILE_KINDS).toHaveLength(42);
    expect(new Set(TILE_KINDS.map(tileFaceKey)).size).toBe(42);
    for (const pack of [defaultGameAssetSet, sampleGameAssetSet]) {
      const artwork = [
        ...TILE_KINDS.map((kind) => pack.tiles.faces[tileFaceKey(kind)]),
        pack.tiles.back,
        pack.board.surface,
        pack.players.human,
        pack.players.bot,
        ...WINDS.map((wind) => pack.icons.winds[wind]),
        pack.icons.turn,
        ...ACTION_ICONS.map((action) => pack.icons.actions[action]),
      ];
      for (const asset of artwork) {
        expect(asset?.src).toMatch(/^data:image\/svg\+xml,/);
        expect(asset?.width).toBeGreaterThan(0);
        expect(asset?.height).toBeGreaterThan(0);
      }
    }
    expect(resolveGameAssetSet()).toEqual(defaultGameAssetSet);
    expect(resolveGameAssetSet({ set: sampleGameAssetSet })).toEqual(
      sampleGameAssetSet,
    );
    for (const kind of TILE_KINDS) {
      const key = tileFaceKey(kind);
      expect(defaultGameAssetSet.tiles.faces[key]?.src).not.toBe(
        sampleGameAssetSet.tiles.faces[key]?.src,
      );
    }
    expect(defaultGameAssetSet.board).not.toEqual(sampleGameAssetSet.board);
    expect(defaultGameAssetSet.players).not.toEqual(sampleGameAssetSet.players);
    expect(defaultGameAssetSet.icons).not.toEqual(sampleGameAssetSet.icons);
    expect(defaultGameAssetSet.tiles.back).not.toEqual(
      sampleGameAssetSet.tiles.back,
    );
  });

  it("overrides one entry without replacing its siblings or mutating a pack", () => {
    const resolved = resolveGameAssetSet({
      overrides: {
        tiles: { faces: { "wind:east": custom } },
        icons: { actions: { draw: custom } },
      },
    });
    expect(resolved.tiles.faces["wind:east"]).toBe(custom);
    expect(resolved.tiles.faces["wind:south"]).toBe(
      defaultGameAssetSet.tiles.faces["wind:south"],
    );
    expect(resolved.tiles.back).toBe(defaultGameAssetSet.tiles.back);
    expect(resolved.icons.actions.draw).toBe(custom);
    expect(resolved.icons.actions.pass).toBe(
      defaultGameAssetSet.icons.actions.pass,
    );
    expect(resolved.board).toEqual(defaultGameAssetSet.board);
    expect(defaultGameAssetSet.tiles.faces["wind:east"]).not.toBe(custom);
    expect(defaultGameAssetSet.icons.actions.draw).not.toBe(custom);
  });

  it("overrides categories on the selected whole pack", () => {
    const resolved = resolveGameAssetSet({
      set: sampleGameAssetSet,
      overrides: {
        players: { human: custom, bot: custom },
        board: { surface: custom },
        icons: { winds: { east: custom }, turn: custom },
      },
    });
    expect(resolved.players).toEqual({ human: custom, bot: custom });
    expect(resolved.board.surface).toBe(custom);
    expect(resolved.tiles).toEqual(sampleGameAssetSet.tiles);
    expect(resolved.icons.winds.east).toBe(custom);
    expect(resolved.icons.winds.south).toBe(
      sampleGameAssetSet.icons.winds.south,
    );
    expect(resolved.icons.turn).toBe(custom);
  });

  it("preserves absent artwork for readable component fallbacks", () => {
    const minimal: GameAssetSet = {
      id: "text-only",
      tiles: { faces: {} },
      board: {},
      players: {},
      icons: { winds: {}, actions: {} },
    };
    const resolved = resolveGameAssetSet({ set: minimal });
    expect(resolved.tiles.faces["wind:east"]).toBeUndefined();
    expect(resolved.tiles.back).toBeUndefined();
    expect(resolved.players.human).toBeUndefined();
    expect(resolved.board.surface).toBeUndefined();
    expect(resolved.icons.actions.draw).toBeUndefined();
  });
});

describe("structured tile artwork keys", () => {
  it("uses kind fields independent of physical IDs and display strings", () => {
    const kind = presentationTileKind({
      type: "suited",
      suit: "bamboo",
      rank: 9,
    });
    expect(kind).toEqual({ type: "suited", suit: "bamboo", rank: 9 });
    expect(kind && tileFaceKey(kind)).toBe("suited:bamboo:9");
    expect(kind && tileKindLabel(kind)).toBe("9 bamboo");
    for (const candidate of TILE_KINDS) {
      expect(presentationTileKind({ ...candidate })).toEqual(candidate);
      expect(tileKindLabel(candidate)).not.toBe("");
    }
  });

  it("distinguishes bonus families and ignores bonus metadata for artwork", () => {
    expect(
      presentationTileKind({
        type: "bonus",
        family: "flower",
        name: "bamboo",
        number: 4,
        matchingSeat: "north",
      }),
    ).toEqual({ type: "bonus", family: "flower", name: "bamboo" });
    expect(
      presentationTileKind({ type: "bonus", family: "season", name: "bamboo" }),
    ).toBeUndefined();
    expect(
      tileFaceKey({ type: "bonus", family: "flower", name: "bamboo" }),
    ).toBe("bonus:flower:bamboo");
    expect(
      tileFaceKey({ type: "bonus", family: "season", name: "spring" }),
    ).toBe("bonus:season:spring");
  });

  it.each([
    {},
    { type: "suited", suit: "bamboo", rank: "9" },
    { type: "suited", suit: "bamboo", rank: 10 },
    { type: "wind", wind: "northeast" },
    { type: "dragon", dragon: "purple" },
    { type: "bonus", name: "spring" },
    { type: "suited", label: "9 bamboo", id: 104 },
  ])("leaves unsupported kinds unresolved: %j", (kind) => {
    expect(presentationTileKind(kind)).toBeUndefined();
  });
});
