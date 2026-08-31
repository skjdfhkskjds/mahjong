import type { Tile } from "@mahjong/game-core";

import type { HongKongTileKind } from "../tiles/hong-kong-tile-kind.js";

export const HONG_KONG_V1_SHUFFLE_ALGORITHM =
  "random-bytes-rejection-fisher-yates/v1";
export const HONG_KONG_V1_RANDOM_BYTES = 1_028;

class RandomWordStream {
  private readonly bytes: Uint8Array;
  private offset: number;

  public constructor(bytes: Uint8Array, offset: number) {
    this.bytes = bytes;
    this.offset = offset;
  }

  public next(): number {
    if (this.offset + 4 > this.bytes.length) {
      throw new RangeError("Random byte input was exhausted.");
    }
    const value =
      ((this.bytes[this.offset] ?? 0) |
        ((this.bytes[this.offset + 1] ?? 0) << 8) |
        ((this.bytes[this.offset + 2] ?? 0) << 16) |
        ((this.bytes[this.offset + 3] ?? 0) << 24)) >>>
      0;
    this.offset += 4;
    return value;
  }
}

function uniformIndex(
  stream: RandomWordStream,
  upperExclusive: number,
): number {
  const limit = Math.floor(0x1_00_00_00_00 / upperExclusive) * upperExclusive;
  let value = stream.next();
  while (value >= limit) value = stream.next();
  return value % upperExclusive;
}

function validateRandomness(randomness: Uint8Array): void {
  if (randomness.length < HONG_KONG_V1_RANDOM_BYTES) {
    throw new RangeError(
      `Hong Kong v1 setup requires at least ${String(HONG_KONG_V1_RANDOM_BYTES)} random bytes.`,
    );
  }
}

export function selectInitialDealerPosition(randomness: Uint8Array): number {
  validateRandomness(randomness);
  return uniformIndex(new RandomWordStream(randomness, 0), 4);
}

export function deterministicShuffle(
  tiles: readonly Tile<HongKongTileKind>[],
  randomness: Uint8Array,
): readonly Tile<HongKongTileKind>[] {
  validateRandomness(randomness);
  const shuffled = [...tiles];
  const stream = new RandomWordStream(randomness, 4);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = uniformIndex(stream, index + 1);
    const value = shuffled[index];
    const replacement = shuffled[swapIndex];
    if (value === undefined || replacement === undefined) {
      throw new Error("Shuffle index escaped the tile inventory.");
    }
    shuffled[index] = replacement;
    shuffled[swapIndex] = value;
  }
  return shuffled;
}
