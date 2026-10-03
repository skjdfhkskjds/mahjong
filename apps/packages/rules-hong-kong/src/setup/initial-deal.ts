import { seat, seats, type Seat } from "@mahjong/game-core";

function packet(target: Seat): readonly Seat[] {
  return [target, target, target, target];
}

const packetRound = seats.flatMap(packet);

export const initialDealSeatOrder: readonly Seat[] = [
  ...packetRound,
  ...packetRound,
  ...packetRound,
  seat("east"),
  seat("east"),
  seat("south"),
  seat("west"),
  seat("north"),
];
