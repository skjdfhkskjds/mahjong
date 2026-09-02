import { nextSeat, type Seat, type TileId } from "@mahjong/game-core";

import {
  playerAt,
  type CanonicalGameStateV2,
  type ReactionResponse,
  type ReactionWindow,
} from "../engine/game-state.js";
import { canonicalTileIds } from "../melds/meld.js";
import {
  sameTileKind,
  tileKind,
  tileKindKey,
} from "../tiles/tile-kind-identity.js";

export interface LegalReactionOptions {
  readonly includeStructuralWin?: boolean;
}

export function legalReactionsForSeat(
  state: CanonicalGameStateV2,
  responderSeat: Seat,
  options: LegalReactionOptions = {},
): readonly ReactionResponse[] {
  const window = state.reactionWindow;
  if (!window?.responderOrder.includes(responderSeat)) {
    return [];
  }
  const player = playerAt(state.players, responderSeat);
  const actions: ReactionResponse[] = [{ type: "pass" }];
  if (
    options.includeStructuralWin === true &&
    isStructurallyWinningWith(state, responderSeat, window.sourceTileId)
  ) {
    actions.push({ type: "win", structurallyEligible: true });
  }
  if (window.kind === "added-kong") return actions;

  const matches = player.hand.filter((id) =>
    sameTileKind(id, window.sourceTileId),
  );
  for (const pair of combinations(matches, 2)) {
    const [first, second] = canonicalTileIds(pair);
    if (first !== undefined && second !== undefined) {
      actions.push({ type: "pung", handTileIds: [first, second] });
    }
  }
  for (const triple of combinations(matches, 3)) {
    const [first, second, third] = canonicalTileIds(triple);
    if (first !== undefined && second !== undefined && third !== undefined) {
      actions.push({
        type: "kong",
        handTileIds: [first, second, third],
      });
    }
  }
  if (responderSeat === nextSeat(window.sourceSeat)) {
    actions.push(...legalChows(player.hand, window.sourceTileId));
  }
  return actions.sort(compareReaction);
}

export function isLegalReaction(
  state: CanonicalGameStateV2,
  responderSeat: Seat,
  response: ReactionResponse,
  options: LegalReactionOptions = {},
): boolean {
  return legalReactionsForSeat(state, responderSeat, options).some(
    (candidate) => reactionKey(candidate) === reactionKey(response),
  );
}

export function isStructurallyWinningWith(
  state: CanonicalGameStateV2,
  seat: Seat,
  tileId: TileId,
): boolean {
  const player = playerAt(state.players, seat);
  if (player.melds.length === 0) {
    const keys = [...player.hand, tileId].map(tileKindKey);
    const counts = countKinds(keys);
    if (
      counts.size === 7 &&
      [...counts.values()].every((count) => count === 2)
    ) {
      return true;
    }
    const orphanKeys = new Set([
      "s:characters:1",
      "s:characters:9",
      "s:circles:1",
      "s:circles:9",
      "s:bamboo:1",
      "s:bamboo:9",
      "w:east",
      "w:south",
      "w:west",
      "w:north",
      "d:red",
      "d:green",
      "d:white",
    ]);
    if (
      keys.every((key) => orphanKeys.has(key)) &&
      orphanKeys.size === counts.size &&
      [...counts.values()].some((count) => count === 2)
    ) {
      return true;
    }
  }
  const requiredMelds = 4 - player.melds.length;
  if (requiredMelds < 0) return false;
  const counts = countKinds([...player.hand, tileId].map(tileKindKey));
  for (const [pairKey, count] of counts) {
    if (count < 2) continue;
    const afterPair = new Map(counts);
    decrement(afterPair, pairKey, 2);
    if (canPartitionMelds(afterPair, requiredMelds)) return true;
  }
  return false;
}

export function reactionKey(response: ReactionResponse): string {
  if (response.type === "pass" || response.type === "win") {
    return response.type;
  }
  return `${response.type}:${response.handTileIds.map(Number).join(",")}`;
}

function legalChows(
  hand: readonly TileId[],
  sourceTileId: TileId,
): readonly ReactionResponse[] {
  const source = tileKind(sourceTileId);
  if (source.type !== "suited") return [];
  const actions: ReactionResponse[] = [];
  for (let start = source.rank - 2; start <= source.rank; start += 1) {
    if (start < 1 || start > 7) continue;
    const requiredRanks = [start, start + 1, start + 2].filter(
      (rank) => rank !== source.rank,
    );
    const firstCandidates = hand.filter((id) => {
      const kind = tileKind(id);
      return (
        kind.type === "suited" &&
        kind.suit === source.suit &&
        kind.rank === requiredRanks[0]
      );
    });
    const secondCandidates = hand.filter((id) => {
      const kind = tileKind(id);
      return (
        kind.type === "suited" &&
        kind.suit === source.suit &&
        kind.rank === requiredRanks[1]
      );
    });
    for (const first of firstCandidates) {
      for (const second of secondCandidates) {
        const [lower, upper] = canonicalTileIds([first, second]);
        if (lower !== undefined && upper !== undefined) {
          actions.push({ type: "chow", handTileIds: [lower, upper] });
        }
      }
    }
  }
  return actions;
}

function combinations<Value>(
  values: readonly Value[],
  size: number,
): readonly (readonly Value[])[] {
  if (size === 0) return [[]];
  return values.flatMap((value, index) =>
    combinations(values.slice(index + 1), size - 1).map((tail) => [
      value,
      ...tail,
    ]),
  );
}

function compareReaction(
  left: ReactionResponse,
  right: ReactionResponse,
): number {
  return reactionKey(left).localeCompare(reactionKey(right));
}

function countKinds(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function decrement(
  counts: Map<string, number>,
  key: string,
  amount: number,
): void {
  const next = (counts.get(key) ?? 0) - amount;
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
}

function canPartitionMelds(
  counts: Map<string, number>,
  remaining: number,
): boolean {
  if (counts.size === 0) return remaining === 0;
  if (remaining === 0) return false;
  const key = [...counts.keys()].sort()[0];
  if (key === undefined) return false;
  const count = counts.get(key) ?? 0;
  if (count >= 3) {
    const triplet = new Map(counts);
    decrement(triplet, key, 3);
    if (canPartitionMelds(triplet, remaining - 1)) return true;
  }
  const parts = key.split(":");
  if (parts[0] !== "s") return false;
  const suit = parts[1];
  if (suit === undefined) return false;
  const rank = Number(parts[2]);
  if (!Number.isSafeInteger(rank) || rank > 7) return false;
  const second = `s:${suit}:${String(rank + 1)}`;
  const third = `s:${suit}:${String(rank + 2)}`;
  if ((counts.get(second) ?? 0) < 1 || (counts.get(third) ?? 0) < 1) {
    return false;
  }
  const chow = new Map(counts);
  decrement(chow, key, 1);
  decrement(chow, second, 1);
  decrement(chow, third, 1);
  return canPartitionMelds(chow, remaining - 1);
}

export function responderActorId(
  state: CanonicalGameStateV2,
  window: ReactionWindow,
  seat: Seat,
): string {
  if (!window.responderOrder.includes(seat)) {
    throw new Error("Seat is not a responder in this window.");
  }
  return playerAt(state.players, seat).actorId;
}
