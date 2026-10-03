import type { Seat, TileId } from "@mahjong/game-core";

import { playerAt, type CanonicalGameStateV2 } from "../engine/game-state.js";
import type { DeclaredMeld } from "../melds/meld.js";
import { canonicalTileIds } from "../melds/meld.js";
import { isBonusTile, sameTileKind } from "../tiles/tile-kind-identity.js";

export interface ReplacementOutcome {
  readonly exhausted: boolean;
  readonly tileIds: readonly TileId[];
}

export function legalConcealedKongs(
  state: CanonicalGameStateV2,
  seat: Seat,
): readonly (readonly [TileId, TileId, TileId, TileId])[] {
  if (
    seat !== state.turn ||
    (state.phase !== "awaiting-dealer-discard" &&
      state.phase !== "awaiting-discard") ||
    state.turnProvenance.replacementPending
  ) {
    return [];
  }
  const byKind = new Map<string, TileId[]>();
  for (const id of playerAt(state.players, seat).hand) {
    const representative = [...byKind.entries()].find(([, ids]) => {
      const first = ids[0];
      return first !== undefined && sameTileKind(first, id);
    });
    if (representative === undefined) byKind.set(String(Number(id)), [id]);
    else representative[1].push(id);
  }
  return [...byKind.values()].flatMap((ids) => {
    if (ids.length !== 4) return [];
    const [first, second, third, fourth] = canonicalTileIds(ids);
    return first !== undefined &&
      second !== undefined &&
      third !== undefined &&
      fourth !== undefined
      ? [[first, second, third, fourth] as const]
      : [];
  });
}

export function legalAddedKongs(
  state: CanonicalGameStateV2,
  seat: Seat,
): readonly { readonly meldId: string; readonly tileId: TileId }[] {
  if (
    seat !== state.turn ||
    (state.phase !== "awaiting-dealer-discard" &&
      state.phase !== "awaiting-discard") ||
    state.turnProvenance.replacementPending
  ) {
    return [];
  }
  const player = playerAt(state.players, seat);
  return player.melds.flatMap((meld) => {
    if (meld.kind !== "pung" || meld.exposure !== "exposed") return [];
    const first = meld.tileIds[0];
    if (first === undefined) return [];
    return player.hand
      .filter((id) => sameTileKind(id, first))
      .map((tileId) => ({ meldId: meld.id, tileId }));
  });
}

export function replacementFromTail(
  state: CanonicalGameStateV2,
): ReplacementOutcome {
  const tileIds: TileId[] = [];
  let tail = state.wall.tail;
  while (tail >= state.wall.head) {
    const id = state.wall.order[tail];
    if (id === undefined) break;
    tileIds.push(id);
    tail -= 1;
    if (!isBonusTile(id)) return { exhausted: false, tileIds };
  }
  return { exhausted: true, tileIds };
}

export function concealedKongMeld(
  sequence: number,
  tileIds: readonly [TileId, TileId, TileId, TileId],
): DeclaredMeld {
  return {
    exposure: "concealed",
    id: `meld:${String(sequence)}`,
    kind: "kong",
    kongKind: "concealed",
    tileIds: canonicalTileIds(tileIds),
  };
}
