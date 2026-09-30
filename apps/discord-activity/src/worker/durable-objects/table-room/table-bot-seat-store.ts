import type { BotSeatChange } from "./table-bot-seating.js";

/** Called only by the enclosing command commit, with its receipt and revision. */
export function writeBotSeatChangeInTransaction(
  sql: SqlStorage,
  change: BotSeatChange,
  now: number,
): void {
  if (change.kind === "remove") {
    sql.exec("DELETE FROM lobby_seats WHERE actor_id = ?", change.actorId);
    sql.exec("DELETE FROM members WHERE actor_id = ?", change.actorId);
    return;
  }
  const seat = change.seat;
  sql.exec(
    "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'member', ?)",
    seat.actorId,
    seat.displayName,
    now,
  );
  sql.exec(
    "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES (?, ?, ?, ?)",
    seat.seat,
    seat.actorId,
    seat.displayName,
    Number(seat.ready),
  );
  sql.exec(
    "INSERT INTO bot_players (actor_id, policy_version) VALUES (?, 'random/v1')",
    seat.actorId,
  );
}
