import {
  nextSeat,
  seat,
  seats,
  tileId,
  type Seat,
  type StandardTileKind,
  type SuitedRank,
  type TileId,
} from "@mahjong/game-core";

import type { DeclaredMeld } from "../melds/meld.js";
import {
  createScoringHandFixture,
  scoringTileId,
  type ScoringHandFixture,
  type WinningConditions,
  type WinningTileSource,
} from "./hand-fixture.js";

export interface MeldSpec {
  readonly claimedIndex?: number;
  readonly exposure?: "concealed" | "exposed";
  readonly kind: "chow" | "kong" | "pung";
  readonly kongKind?: "added" | "concealed" | "exposed";
  readonly sourceSeat?: Seat;
  readonly tiles: string;
}

export interface FixtureSpec {
  readonly bonuses?: readonly number[];
  readonly concealed: string;
  readonly conditions?: Partial<WinningConditions>;
  readonly melds?: readonly MeldSpec[];
  readonly prevailingWind?: Seat;
  readonly source?: WinningTileSource;
  readonly winner?: Seat;
  readonly winningToken?: string;
}

const ranks: Readonly<Record<string, SuitedRank>> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
};

function kindForToken(token: string): StandardTileKind {
  const honorKinds: Readonly<Record<string, StandardTileKind>> = {
    E: { type: "wind", wind: "east" },
    G: { type: "dragon", dragon: "green" },
    N: { type: "wind", wind: "north" },
    R: { type: "dragon", dragon: "red" },
    S: { type: "wind", wind: "south" },
    W: { type: "wind", wind: "west" },
    H: { type: "dragon", dragon: "white" },
  };
  const honor = honorKinds[token];
  if (honor !== undefined) return honor;
  const rank = ranks[token.slice(1)];
  const suit = token.startsWith("c")
    ? "characters"
    : token.startsWith("o")
      ? "circles"
      : token.startsWith("b")
        ? "bamboo"
        : null;
  if (rank === undefined || suit === null) {
    throw new RangeError(`Unknown fixture tile token: ${token}`);
  }
  return { type: "suited", rank, suit };
}

function tokens(source: string): readonly string[] {
  return source.trim().split(/\s+/u).filter(Boolean);
}

function previousSeat(currentSeat: Seat): Seat {
  for (const candidate of seats) {
    if (nextSeat(candidate) === currentSeat) return candidate;
  }
  throw new RangeError("Unknown fixture winner seat.");
}

export function scoringFixture(spec: FixtureSpec): ScoringHandFixture {
  const winnerSeat = spec.winner ?? seat("west");
  const copies = new Map<string, number>();
  const idsByToken = new Map<string, TileId[]>();
  function allocate(source: string): readonly TileId[] {
    return tokens(source).map((token) => {
      const copy = copies.get(token) ?? 0;
      if (copy > 3) throw new RangeError(`Too many fixture copies: ${token}`);
      const id = scoringTileId(kindForToken(token), copy as 0 | 1 | 2 | 3);
      copies.set(token, copy + 1);
      const ids = idsByToken.get(token) ?? [];
      ids.push(id);
      idsByToken.set(token, ids);
      return id;
    });
  }

  const melds: DeclaredMeld[] = (spec.melds ?? []).map((meld, index) => {
    const exposure = meld.exposure ?? "exposed";
    const tileIds = allocate(meld.tiles);
    const claimedTileId = tileIds[meld.claimedIndex ?? 0];
    if (claimedTileId === undefined) {
      throw new RangeError("A fixture meld must contain its claimed tile.");
    }
    return {
      exposure,
      id: `fixture:meld:${String(index)}`,
      kind: meld.kind,
      tileIds,
      ...(exposure === "concealed"
        ? {}
        : {
            claimedTileId,
            sourceSeat: meld.sourceSeat ?? previousSeat(winnerSeat),
          }),
      ...(meld.kongKind === undefined ? {} : { kongKind: meld.kongKind }),
    };
  });
  const concealedTileIds = allocate(spec.concealed);
  const winningIds =
    spec.winningToken === undefined
      ? concealedTileIds
      : (idsByToken.get(spec.winningToken) ?? []);
  const winningTileId = winningIds.at(-1);
  if (winningTileId === undefined) {
    throw new RangeError("A fixture must identify its winning tile.");
  }
  return createScoringHandFixture({
    bonusTileIds: (spec.bonuses ?? []).map(tileId),
    concealedTileIds,
    declaredMelds: melds,
    prevailingWind: spec.prevailingWind ?? seat("east"),
    winnerSeat,
    ...(spec.conditions === undefined
      ? {}
      : { winningConditions: spec.conditions }),
    winningTileId,
    winningTileSource: spec.source ?? {
      type: "discard",
      sourceSeat: seat("south"),
    },
  });
}
