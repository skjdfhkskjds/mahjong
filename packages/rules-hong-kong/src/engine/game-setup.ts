import { seat, seats, type TileId } from "@mahjong/game-core";

import { initialDealSeatOrder } from "../setup/initial-deal.js";
import type { DeclaredMeld } from "../melds/meld.js";
import { isBonusTile } from "../tiles/tile-kind-identity.js";
import { createHongKongV1TileSet } from "../wall/create-tile-set.js";
import {
  deterministicShuffle,
  HONG_KONG_V1_SHUFFLE_ALGORITHM,
  selectInitialDealerPosition,
} from "../wall/deterministic-shuffle.js";
import type { StartedEventV1 } from "./game-contracts.js";
import { assertGameInvariants } from "./game-invariants.js";
import {
  playerAt,
  seatName,
  type CanonicalGameStateV1,
  type CanonicalPlayerStateV1,
  type SeatMap,
} from "./game-state.js";

const inventory = createHongKongV1TileSet();

export function startHongKongV1Game(
  stablePositions: SeatMap<string>,
  randomness: Uint8Array,
): { readonly event: StartedEventV1; readonly state: CanonicalGameStateV1 } {
  if (new Set(Object.values(stablePositions)).size !== seats.length) {
    throw new TypeError("A game requires four distinct seated actors.");
  }
  const order = deterministicShuffle(inventory, randomness).map(({ id }) => id);
  const dealerPosition = selectInitialDealerPosition(randomness);
  const actors = Object.fromEntries(
    seats.map((wind, offset) => {
      const position = seats[(dealerPosition + offset) % seats.length];
      if (position === undefined) throw new Error("Invalid dealer position.");
      return [wind, stablePositions[seatName(position)]];
    }),
  ) as unknown as SeatMap<string>;
  const mutable = Object.fromEntries(
    seats.map((currentSeat) => [
      currentSeat,
      {
        actorId: actors[seatName(currentSeat)],
        bonuses: [] as TileId[],
        discards: [] as TileId[],
        hand: [] as TileId[],
        melds: [] as DeclaredMeld[],
        seat: currentSeat,
      },
    ]),
  ) as unknown as SeatMap<
    CanonicalPlayerStateV1 & { bonuses: TileId[]; hand: TileId[] }
  >;
  const acquired = Object.fromEntries(
    seats.map((currentSeat) => [currentSeat, [] as TileId[]]),
  ) as unknown as SeatMap<TileId[]>;
  let head = 0;
  let tail = order.length - 1;
  for (const assignedSeat of initialDealSeatOrder) {
    const id = order[head];
    if (id === undefined || head > tail) {
      throw new Error("Wall exhausted during initial deal.");
    }
    head += 1;
    playerAt(acquired, assignedSeat).push(id);
  }
  let exhausted = false;
  let eastLastReplacementTileId: TileId | null = null;
  for (const currentSeat of seats) {
    for (const dealtId of playerAt(acquired, currentSeat)) {
      let id: TileId | undefined = dealtId;
      let replacementRequired = false;
      while (id !== undefined && isBonusTile(id)) {
        replacementRequired = true;
        playerAt(mutable, currentSeat).bonuses.push(id);
        if (head > tail) {
          id = undefined;
          exhausted = true;
        } else {
          id = order[tail];
          tail -= 1;
        }
      }
      if (id !== undefined) {
        playerAt(mutable, currentSeat).hand.push(id);
        if (currentSeat === seat("east") && replacementRequired) {
          eastLastReplacementTileId = id;
        }
      }
    }
  }
  const eastHand = mutable.east.hand;
  const state: CanonicalGameStateV1 = {
    completionProvenance: null,
    phase: exhausted ? "exhausted" : "awaiting-dealer-discard",
    players: mutable,
    prevailingWind: "east",
    reactionWindow: null,
    result: null,
    ruleset: "hong-kong/v1",
    schemaVersion: 1,
    sequence: 1,
    shuffleAlgorithm: HONG_KONG_V1_SHUFFLE_ALGORITHM,
    turn: seat("east"),
    turnProvenance: {
      eastHasDeclaredKong: false,
      eastHasDiscarded: false,
      lastAcquiredTileId: eastLastReplacementTileId ?? eastHand.at(-1) ?? null,
      lastAcquiredTileWasFinalWall: false,
      lastAcquisition:
        eastLastReplacementTileId === null ? "deal" : "bonus-replacement",
      replacementChainDepth: 0,
      replacementPending: false,
    },
    wall: { head, order, tail },
  };
  assertGameInvariants(state);
  return { event: { type: "game/started", sequence: 1, state }, state };
}
