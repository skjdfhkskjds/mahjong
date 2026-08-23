import type { Brand } from "../identity/brand.js";
import type { Wind } from "../tiles/tile-kind.js";

export type Seat = Brand<Wind, "Seat">;

export function seat(wind: Wind): Seat {
  return wind as Seat;
}

export const seats = [
  seat("east"),
  seat("south"),
  seat("west"),
  seat("north"),
] as const;

export function nextSeat(current: Seat): Seat {
  const currentIndex = seats.indexOf(current);
  if (currentIndex < 0) {
    throw new RangeError(`Unknown seat: ${current}`);
  }

  const nextIndex = (currentIndex + 1) % seats.length;
  const next = seats[nextIndex];
  if (next === undefined) {
    throw new RangeError(`Unknown seat: ${current}`);
  }

  return next;
}
