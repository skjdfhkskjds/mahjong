import type { Seat, StandardTileKind, TileId } from "@mahjong/game-core";

import type { DeclaredMeld, KongKind } from "../melds/meld.js";
import { tileKind, tileKindKey } from "../tiles/tile-kind-identity.js";
import type { ScoringHandFixture } from "./hand-fixture.js";

export interface ScoringMeld {
  readonly exposure: "concealed" | "exposed";
  readonly kind: "chow" | "kong" | "pung";
  readonly origin: "concealed" | "declared";
  readonly tileIds: readonly TileId[];
  readonly claimedTileId?: TileId;
  readonly declaredMeldId?: string;
  readonly kongKind?: KongKind;
  readonly sourceSeat?: Seat;
}

export type HandDecomposition =
  | {
      readonly encoding: string;
      readonly kind: "seven-pairs";
      readonly pairs: readonly (readonly [TileId, TileId])[];
    }
  | {
      readonly duplicate: TileId;
      readonly encoding: string;
      readonly kind: "thirteen-orphans";
      readonly tileIds: readonly TileId[];
    }
  | {
      readonly encoding: string;
      readonly kind: "standard";
      readonly melds: readonly ScoringMeld[];
      readonly pair: readonly [TileId, TileId];
    };

interface KindGroup {
  readonly kind: "chow" | "pung";
  readonly keys: readonly string[];
}

interface KindDecomposition {
  readonly groups: readonly KindGroup[];
  readonly pairKey: string;
}

function standardKind(id: TileId): StandardTileKind {
  const kind = tileKind(id);
  if (kind.type === "bonus") {
    throw new RangeError("A structural decomposition cannot contain bonuses.");
  }
  return kind;
}

function sortedIds(ids: readonly TileId[]): readonly TileId[] {
  return [...ids].sort((left, right) => Number(left) - Number(right));
}

function groupedIds(ids: readonly TileId[]): Map<string, readonly TileId[]> {
  const groups = new Map<string, TileId[]>();
  for (const id of sortedIds(ids)) {
    const key = tileKindKey(id);
    const group = groups.get(key) ?? [];
    group.push(id);
    groups.set(key, group);
  }
  return new Map([...groups].map(([key, value]) => [key, value]));
}

function suitedSequenceKeys(
  id: TileId,
): readonly [string, string, string] | null {
  const kind = standardKind(id);
  if (kind.type !== "suited" || kind.rank > 7) return null;
  return [
    `s:${kind.suit}:${String(kind.rank)}`,
    `s:${kind.suit}:${String(kind.rank + 1)}`,
    `s:${kind.suit}:${String(kind.rank + 2)}`,
  ];
}

function enumerateKinds(
  idsByKey: ReadonlyMap<string, readonly TileId[]>,
  requiredGroups: number,
): readonly KindDecomposition[] {
  const counts = new Map(
    [...idsByKey].map(([key, ids]) => [key, ids.length] as const),
  );
  const firstIds = new Map(
    [...idsByKey].flatMap(([key, ids]) => {
      const first = ids[0];
      return first === undefined ? [] : [[key, first] as const];
    }),
  );
  const results: KindDecomposition[] = [];

  function take(keys: readonly string[], delta: -1 | 1): void {
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + delta);
  }

  function visit(groups: readonly KindGroup[], pairKey: string | null): void {
    const firstKey = [...counts]
      .filter(([, count]) => count > 0)
      .map(([key]) => key)
      .sort()[0];
    if (firstKey === undefined) {
      if (pairKey !== null && groups.length === requiredGroups) {
        results.push({ groups, pairKey });
      }
      return;
    }
    if (groups.length > requiredGroups) return;
    const count = counts.get(firstKey) ?? 0;

    if (pairKey === null && count >= 2) {
      take([firstKey, firstKey], -1);
      visit(groups, firstKey);
      take([firstKey, firstKey], 1);
    }
    if (count >= 3 && groups.length < requiredGroups) {
      take([firstKey, firstKey, firstKey], -1);
      visit([...groups, { kind: "pung", keys: [firstKey] }], pairKey);
      take([firstKey, firstKey, firstKey], 1);
    }
    const firstId = firstIds.get(firstKey);
    if (firstId === undefined || groups.length >= requiredGroups) return;
    const sequence = suitedSequenceKeys(firstId);
    if (sequence?.every((key) => (counts.get(key) ?? 0) > 0) === true) {
      take(sequence, -1);
      visit([...groups, { kind: "chow", keys: sequence }], pairKey);
      take(sequence, 1);
    }
  }

  visit([], null);
  return results;
}

function declaredScoringMeld(meld: DeclaredMeld): ScoringMeld {
  return {
    exposure: meld.exposure,
    kind: meld.kind,
    origin: "declared",
    tileIds: sortedIds(meld.tileIds),
    declaredMeldId: meld.id,
    ...(meld.claimedTileId === undefined
      ? {}
      : { claimedTileId: meld.claimedTileId }),
    ...(meld.kongKind === undefined ? {} : { kongKind: meld.kongKind }),
    ...(meld.sourceSeat === undefined ? {} : { sourceSeat: meld.sourceSeat }),
  };
}

function materializeStandard(
  fixture: ScoringHandFixture,
  kinds: KindDecomposition,
): HandDecomposition {
  const available = new Map(
    [...groupedIds(fixture.concealedTileIds)].map(([key, ids]) => [
      key,
      [...ids],
    ]),
  );
  function shift(key: string): TileId {
    const id = available.get(key)?.shift();
    if (id === undefined)
      throw new Error("Kind decomposition lost a physical tile.");
    return id;
  }

  const pair = [shift(kinds.pairKey), shift(kinds.pairKey)] as const;
  const concealedMelds = kinds.groups.map((group): ScoringMeld => {
    const repeatedKey = group.keys[0];
    if (repeatedKey === undefined)
      throw new Error("A meld kind group is empty.");
    return {
      exposure: "concealed",
      kind: group.kind,
      origin: "concealed",
      tileIds: sortedIds(
        group.kind === "pung"
          ? [shift(repeatedKey), shift(repeatedKey), shift(repeatedKey)]
          : group.keys.map(shift),
      ),
    };
  });
  const melds = [
    ...fixture.declaredMelds.map(declaredScoringMeld),
    ...concealedMelds,
  ].sort((left, right) => encodeMeld(left).localeCompare(encodeMeld(right)));
  const encoding = `standard|${tileKindKey(pair[0])}:${pair.map(Number).join(",")}|${melds
    .map(encodeMeld)
    .join(";")}`;
  return { encoding, kind: "standard", melds, pair };
}

function encodeMeld(meld: ScoringMeld): string {
  return `${meld.kind}:${meld.exposure}:${meld.tileIds.map(tileKindKey).join(",")}:${meld.tileIds.map(Number).join(",")}:${meld.declaredMeldId ?? "-"}:${meld.sourceSeat ?? "-"}`;
}

function sevenPairs(fixture: ScoringHandFixture): HandDecomposition | null {
  if (fixture.declaredMelds.length !== 0) return null;
  const groups = [...groupedIds(fixture.concealedTileIds)].sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (groups.length !== 7 || groups.some(([, ids]) => ids.length !== 2)) {
    return null;
  }
  const pairs = groups.map(([, ids]) => {
    const first = ids[0];
    const second = ids[1];
    if (first === undefined || second === undefined) {
      throw new Error("Seven Pairs group lost a physical tile.");
    }
    return [first, second] as const;
  });
  return {
    encoding: `seven-pairs|${groups
      .map(([key, ids]) => `${key}:${ids.map(Number).join(",")}`)
      .join(";")}`,
    kind: "seven-pairs",
    pairs,
  };
}

const orphanKeys = new Set([
  "s:bamboo:1",
  "s:bamboo:9",
  "s:characters:1",
  "s:characters:9",
  "s:circles:1",
  "s:circles:9",
  "w:east",
  "w:north",
  "w:south",
  "w:west",
  "d:green",
  "d:red",
  "d:white",
]);

function thirteenOrphans(
  fixture: ScoringHandFixture,
): HandDecomposition | null {
  if (fixture.declaredMelds.length !== 0) return null;
  const groups = groupedIds(fixture.concealedTileIds);
  if (
    groups.size !== orphanKeys.size ||
    [...groups].some(
      ([key, ids]) =>
        !orphanKeys.has(key) || (ids.length !== 1 && ids.length !== 2),
    ) ||
    [...groups.values()].filter((ids) => ids.length === 2).length !== 1
  ) {
    return null;
  }
  const duplicate = [...groups.values()].find((ids) => ids.length === 2)?.[1];
  if (duplicate === undefined) return null;
  return {
    duplicate,
    encoding: `thirteen-orphans|${sortedIds(fixture.concealedTileIds)
      .map((id) => `${tileKindKey(id)}:${String(Number(id))}`)
      .join(";")}|${tileKindKey(duplicate)}`,
    kind: "thirteen-orphans",
    tileIds: sortedIds(fixture.concealedTileIds),
  };
}

export function decomposeWinningHand(
  fixture: ScoringHandFixture,
): readonly HandDecomposition[] {
  const decompositions: HandDecomposition[] = [];
  const requiredGroups = 4 - fixture.declaredMelds.length;
  if (requiredGroups >= 0) {
    for (const kinds of enumerateKinds(
      groupedIds(fixture.concealedTileIds),
      requiredGroups,
    )) {
      decompositions.push(materializeStandard(fixture, kinds));
    }
  }
  const pairs = sevenPairs(fixture);
  if (pairs !== null) decompositions.push(pairs);
  const orphans = thirteenOrphans(fixture);
  if (orphans !== null) decompositions.push(orphans);
  return decompositions.sort((left, right) =>
    left.encoding.localeCompare(right.encoding),
  );
}
