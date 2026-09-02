import { seats, type Seat } from "@mahjong/game-core";

import type { WinningTileSource } from "./hand-fixture.js";

export interface SeatPayments {
  readonly east: number;
  readonly north: number;
  readonly south: number;
  readonly west: number;
}

interface MutableSeatPayments {
  east: number;
  north: number;
  south: number;
  west: number;
}

function setPayment(
  payments: MutableSeatPayments,
  currentSeat: Seat,
  payment: number,
): void {
  switch (String(currentSeat)) {
    case "east":
      payments.east = payment;
      return;
    case "south":
      payments.south = payment;
      return;
    case "west":
      payments.west = payment;
      return;
    case "north":
      payments.north = payment;
      return;
    default:
      throw new RangeError("Unknown payment seat.");
  }
}

const HALF_SPICY_POINTS = {
  3: 8,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
  9: 96,
  10: 128,
  11: 192,
  12: 256,
  13: 384,
} as const;

export function halfSpicyPoints(cappedFaan: number): number {
  if (!Number.isInteger(cappedFaan) || cappedFaan < 3 || cappedFaan > 13) {
    throw new RangeError("Half Spicy conversion requires 3 through 13 faan.");
  }
  return HALF_SPICY_POINTS[cappedFaan as keyof typeof HALF_SPICY_POINTS];
}

export function calculatePayments(input: {
  readonly tablePoints: number;
  readonly winnerSeat: Seat;
  readonly winningTileSource: WinningTileSource;
}): SeatPayments {
  if (!Number.isInteger(input.tablePoints) || input.tablePoints <= 0) {
    throw new RangeError("Table points must be a positive integer.");
  }
  const payments: MutableSeatPayments = {
    east: 0,
    north: 0,
    south: 0,
    west: 0,
  };
  if (input.winningTileSource.type === "self-pick") {
    if (input.tablePoints % 2 !== 0) {
      throw new RangeError(
        "Self-pick table points must divide evenly in half.",
      );
    }
    const perLoser = input.tablePoints / 2;
    for (const currentSeat of seats) {
      if (currentSeat !== input.winnerSeat) {
        setPayment(payments, currentSeat, -perLoser);
      }
    }
    setPayment(payments, input.winnerSeat, perLoser * 3);
  } else {
    setPayment(
      payments,
      input.winningTileSource.sourceSeat,
      -input.tablePoints,
    );
    setPayment(payments, input.winnerSeat, input.tablePoints);
  }
  if (payments.east + payments.south + payments.west + payments.north !== 0) {
    throw new Error("Payment calculation must remain zero-sum.");
  }
  return payments;
}
