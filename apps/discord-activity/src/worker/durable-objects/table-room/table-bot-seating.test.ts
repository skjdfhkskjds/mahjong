import { describe, expect, it } from "vitest";
import { prepareBotSeatChange } from "./table-bot-seating.js";
import type { ApplicationSeat } from "./table-command-application.js";

const owner: ApplicationSeat = {
  actorId: "owner",
  displayName: "Owner",
  seat: "east",
  ready: false,
};
const bot: ApplicationSeat = {
  actorId: "bot:00000000-0000-4000-8000-000000000001",
  displayName: "Bot South",
  seat: "south",
  ready: true,
};
const input = {
  actorId: "owner",
  ownerId: "owner",
  seat: "south",
  command: "lobby/add-bot",
  seats: [owner],
  botIds: new Set<string>(),
  newActorId: () => bot.actorId,
} as const;

describe("bot seat application policy", () => {
  it("prepares an immediately ready named player for the requested vacant seat", () => {
    expect(prepareBotSeatChange(input)).toEqual({
      kind: "accepted",
      change: { kind: "add", seat: bot },
    });
  });
  it("requires both ownership and an existing owner seat", () => {
    expect(prepareBotSeatChange({ ...input, actorId: "member" })).toMatchObject(
      { kind: "rejected", error: { code: "owner-required" } },
    );
    expect(prepareBotSeatChange({ ...input, seats: [] })).toMatchObject({
      kind: "rejected",
      error: { code: "owner-must-be-seated" },
    });
  });
  it("does not create identities for occupied seats or a full bot complement", () => {
    let generated = false;
    const newActorId = () => {
      generated = true;
      return bot.actorId;
    };
    expect(
      prepareBotSeatChange({ ...input, seats: [owner, bot], newActorId }),
    ).toMatchObject({ kind: "rejected", error: { code: "seat-unavailable" } });
    expect(
      prepareBotSeatChange({
        ...input,
        botIds: new Set(["one", "two", "three"]),
        newActorId,
      }),
    ).toMatchObject({ kind: "rejected", error: { code: "seat-unavailable" } });
    expect(generated).toBe(false);
  });
  it("removes only the selected dedicated bot while retaining the owner", () => {
    expect(
      prepareBotSeatChange({
        ...input,
        command: "lobby/remove-bot",
        seats: [owner, bot],
        botIds: new Set([bot.actorId]),
      }),
    ).toEqual({
      kind: "accepted",
      change: { kind: "remove", actorId: bot.actorId },
    });
    expect(
      prepareBotSeatChange({
        ...input,
        command: "lobby/remove-bot",
        seat: "east",
        seats: [owner, bot],
        botIds: new Set([bot.actorId]),
      }),
    ).toMatchObject({ kind: "rejected", error: { code: "bot-required" } });
  });
});
