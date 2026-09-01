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
import type { StartedEventV1, StartedEventV2 } from "./game-contracts.js";
import { assertGameInvariants } from "./game-invariants-migration.js";
import {
  playerAt,
  seatName,
  type CanonicalGameStateV1,
  type CanonicalGameStateV2,
  type CanonicalPlayerStateV1,
  type CanonicalPlayerStateV2,
  type SeatMap,
} from "./game-state.js";

const inventory = createHongKongV1TileSet();

export function startHongKongV2Game(
  stablePositions: SeatMap<string>,
  randomness: Uint8Array,
): { readonly event: StartedEventV2; readonly state: CanonicalGameStateV2 } {
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
    CanonicalPlayerStateV2 & { bonuses: TileId[]; hand: TileId[] }
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
  for (const currentSeat of seats) {
    for (const dealtId of playerAt(acquired, currentSeat)) {
      let id: TileId | undefined = dealtId;
      while (id !== undefined && isBonusTile(id)) {
        playerAt(mutable, currentSeat).bonuses.push(id);
        if (head > tail) {
          id = undefined;
          exhausted = true;
        } else {
          id = order[tail];
          tail -= 1;
        }
      }
      if (id !== undefined) playerAt(mutable, currentSeat).hand.push(id);
    }
  }
  const eastHand = mutable.east.hand;
  const state: CanonicalGameStateV2 = {
    phase: exhausted ? "exhausted" : "awaiting-dealer-discard",
    players: mutable,
    prevailingWind: "east",
    reactionWindow: null,
    result: null,
    ruleset: "hong-kong/v1",
    schemaVersion: 2,
    sequence: 1,
    shuffleAlgorithm: HONG_KONG_V1_SHUFFLE_ALGORITHM,
    turn: seat("east"),
    turnProvenance: {
      eastHasDeclaredKong: false,
      eastHasDiscarded: false,
      lastAcquiredTileId: eastHand.at(-1) ?? null,
      lastAcquisition: "deal",
      replacementChainDepth: 0,
      replacementPending: false,
    },
    wall: { head, order, tail },
  };
  assertGameInvariants(state);
  return { event: { type: "game/started", sequence: 1, state }, state };
}

/** Starts the deployed schema-v1 lifecycle. */
export function startHongKongV1Game(
  stablePositions: SeatMap<string>,
  randomness: Uint8Array,
): { readonly event: StartedEventV1; readonly state: CanonicalGameStateV1 } {
  const v2 = startHongKongV2Game(stablePositions, randomness).state;
  const state: CanonicalGameStateV1 = {
    phase: v2.phase === "awaiting-dealer-discard" ? v2.phase : "exhausted",
    players: Object.fromEntries(
      seats.map((currentSeat) => {
        const player = playerAt(v2.players, currentSeat);
        return [
          currentSeat,
          {
            actorId: player.actorId,
            bonuses: player.bonuses,
            discards: player.discards,
            hand: player.hand,
            seat: player.seat,
          },
        ];
      }),
    ) as unknown as SeatMap<CanonicalPlayerStateV1>,
    ruleset: v2.ruleset,
    schemaVersion: 1,
    sequence: v2.sequence,
    shuffleAlgorithm: v2.shuffleAlgorithm,
    turn: v2.turn,
    wall: v2.wall,
  };
  assertGameInvariants(state);
  return { event: { type: "game/started", sequence: 1, state }, state };
}
