import { describe, expect, it } from "vitest";

import {
  parseTableCommand,
  parseTableResync,
  requestedTableProtocol,
} from "../../src/worker/durable-objects/table-room/table-room-protocol.js";

function command(commandValue: object, extra: object = {}): string {
  return JSON.stringify({
    command: commandValue,
    commandId: "strict-command",
    expectedStateVersion: 7,
    protocolVersion: 2,
    type: "table/command",
    ...extra,
  });
}

describe("TableRoom protocol v2", () => {
  it.each([
    { type: "lobby/claim-seat", seat: "east" },
    { type: "lobby/leave-seat" },
    { type: "lobby/set-ready", ready: true },
    { type: "game/start" },
    { type: "game/draw" },
    { type: "game/discard", tileId: 42 },
    {
      type: "game/react",
      response: { type: "chow", handTileIds: [4, 8] },
      windowId: "discard:2",
    },
    {
      type: "game/react",
      response: { type: "pung", handTileIds: [4, 5] },
      windowId: "discard:2",
    },
    {
      type: "game/react",
      response: { type: "kong", handTileIds: [4, 5, 6] },
      windowId: "discard:2",
    },
    {
      type: "game/react",
      response: { type: "pass" },
      windowId: "discard:2",
    },
    {
      type: "game/react",
      response: { type: "win" },
      windowId: "discard:2",
    },
    { type: "game/declare-concealed-kong", tileIds: [4, 5, 6, 7] },
    { type: "game/propose-added-kong", meldId: "meld:3", tileId: 8 },
    { type: "game/declare-win" },
  ])("accepts the closed command $type", (value) => {
    expect(parseTableCommand(command(value))).toMatchObject({ command: value });
  });

  it.each([
    command({ type: "game/draw", extra: true }),
    command({ type: "game/discard", tileId: 144 }),
    command({
      type: "game/react",
      response: { type: "pass", extra: true },
      windowId: "discard:2",
    }),
    command({
      type: "game/react",
      response: { type: "pung", handTileIds: [8, 4] },
      windowId: "discard:2",
    }),
    command({
      type: "game/react",
      response: { type: "kong", handTileIds: [4, 4, 8] },
      windowId: "discard:2",
    }),
    command({ type: "game/declare-concealed-kong", tileIds: [4, 5, 5, 7] }),
    command({ type: "game/declare-concealed-kong", tileIds: [4, 5, 6, 8] }),
    command({
      type: "game/react",
      response: { type: "pung", handTileIds: [4, 8] },
      windowId: "discard:2",
    }),
    command({
      type: "game/react",
      response: { type: "kong", handTileIds: [4, 5, 8] },
      windowId: "discard:2",
    }),
    command({
      type: "game/react",
      response: { type: "chow", handTileIds: [0, 12] },
      windowId: "discard:2",
    }),
    command({
      type: "game/react",
      response: { type: "chow", handTileIds: [32, 36] },
      windowId: "discard:2",
    }),
    command({ type: "game/start" }, { unknown: true }),
    JSON.stringify({
      command: { type: "game/start" },
      commandId: "legacy",
      expectedStateVersion: 0,
      protocolVersion: 1,
      type: "table/command",
    }),
  ])(
    "rejects unknown, invalid, duplicate, or legacy command input",
    (value) => {
      expect(parseTableCommand(value)).toBeUndefined();
    },
  );

  it("strictly validates resync and socket protocol selection", () => {
    expect(
      parseTableResync(
        JSON.stringify({
          lastSeenStateVersion: 4,
          protocolVersion: 2,
          type: "table/resync",
        }),
      ),
    ).toEqual({ lastSeenStateVersion: 4 });
    expect(
      parseTableResync(
        JSON.stringify({
          lastSeenStateVersion: 4,
          protocolVersion: 2,
          type: "table/resync",
          unknown: true,
        }),
      ),
    ).toBeUndefined();
    expect(
      requestedTableProtocol(
        "https://table.internal/connect?protocolVersion=2",
      ),
    ).toBe(2);
    for (const url of [
      "https://table.internal/connect",
      "https://table.internal/connect?protocolVersion=1",
      "https://table.internal/connect?protocolVersion=2&protocolVersion=2",
      "https://table.internal/connect?protocolVersion=99",
    ]) {
      expect(requestedTableProtocol(url)).toBeUndefined();
    }
  });
});
