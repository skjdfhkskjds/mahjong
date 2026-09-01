import type { HongKongGameCommandV2 } from "@mahjong/rules-hong-kong";

type TileId = Extract<
  HongKongGameCommandV2,
  { readonly type: "game/discard" }
>["tileId"];

export const TABLE_PROTOCOL_VERSION = 2;
export const TABLE_PROTOCOL_UPGRADE_CLOSE_CODE = 4406;

const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const WINDOW_ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/u;
const MELD_ID_PATTERN = /^[^\p{Cc}\p{Cf}]{1,96}$/u;
const SEATS = ["east", "south", "west", "north"] as const;

export type TableSeat = (typeof SEATS)[number];

export type TableCommand =
  | { readonly type: "lobby/claim-seat"; readonly seat: TableSeat }
  | { readonly type: "lobby/leave-seat" }
  | { readonly type: "lobby/set-ready"; readonly ready: boolean }
  | { readonly type: "game/start" }
  | HongKongGameCommandV2;

export interface TableCommandEnvelope {
  readonly commandId: string;
  readonly expectedStateVersion: number;
  readonly command: TableCommand;
}

export interface TableResyncEnvelope {
  readonly lastSeenStateVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isTileId(value: unknown): value is TileId {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < 144
  );
}

function standardKindIndex(tileId: TileId): number | undefined {
  return tileId < 136 ? Math.floor(tileId / 4) : undefined;
}

function sameStandardKind(tileIds: readonly TileId[]): boolean {
  const first = tileIds[0];
  if (first === undefined) return false;
  const expected = standardKindIndex(first);
  return (
    expected !== undefined &&
    tileIds.every((tileId) => standardKindIndex(tileId) === expected)
  );
}

function canShareSuitedRun(tileIds: readonly [TileId, TileId]): boolean {
  const firstKind = standardKindIndex(tileIds[0]);
  const secondKind = standardKindIndex(tileIds[1]);
  if (
    firstKind === undefined ||
    secondKind === undefined ||
    firstKind >= 27 ||
    secondKind >= 27 ||
    Math.floor(firstKind / 9) !== Math.floor(secondKind / 9)
  ) {
    return false;
  }
  const distance = Math.abs((firstKind % 9) - (secondKind % 9));
  return distance === 1 || distance === 2;
}

function tileTuple(
  value: unknown,
  length: 2,
): readonly [TileId, TileId] | undefined;
function tileTuple(
  value: unknown,
  length: 3,
): readonly [TileId, TileId, TileId] | undefined;
function tileTuple(
  value: unknown,
  length: 4,
): readonly [TileId, TileId, TileId, TileId] | undefined;
function tileTuple(
  value: unknown,
  length: 2 | 3 | 4,
):
  | readonly [TileId, TileId]
  | readonly [TileId, TileId, TileId]
  | readonly [TileId, TileId, TileId, TileId]
  | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every(isTileId) ||
    value.some((tileId, index) => {
      const previous = value[index - 1];
      return index > 0 && previous !== undefined && tileId <= previous;
    })
  ) {
    return undefined;
  }
  const first = value[0];
  const second = value[1];
  const third = value[2];
  const fourth = value[3];
  if (first === undefined || second === undefined) return undefined;
  if (length === 2) return [first, second];
  if (third === undefined) return undefined;
  if (length === 3) return [first, second, third];
  return fourth === undefined ? undefined : [first, second, third, fourth];
}

function parseReactionResponse(
  value: unknown,
):
  | Extract<HongKongGameCommandV2, { readonly type: "game/react" }>["response"]
  | undefined {
  if (!isRecord(value) || typeof value["type"] !== "string") return undefined;
  if (
    (value["type"] === "pass" || value["type"] === "win") &&
    hasExactKeys(value, ["type"])
  ) {
    return { type: value["type"] };
  }
  if (
    (value["type"] === "chow" || value["type"] === "pung") &&
    hasExactKeys(value, ["handTileIds", "type"])
  ) {
    const handTileIds = tileTuple(value["handTileIds"], 2);
    if (handTileIds === undefined) return undefined;
    if (
      (value["type"] === "chow" && !canShareSuitedRun(handTileIds)) ||
      (value["type"] === "pung" && !sameStandardKind(handTileIds))
    ) {
      return undefined;
    }
    return { type: value["type"], handTileIds };
  }
  if (
    value["type"] === "kong" &&
    hasExactKeys(value, ["handTileIds", "type"])
  ) {
    const handTileIds = tileTuple(value["handTileIds"], 3);
    return handTileIds === undefined || !sameStandardKind(handTileIds)
      ? undefined
      : { type: "kong", handTileIds };
  }
  return undefined;
}

function parseCommand(value: unknown): TableCommand | undefined {
  if (!isRecord(value) || typeof value["type"] !== "string") return undefined;
  if (
    value["type"] === "lobby/claim-seat" &&
    hasExactKeys(value, ["seat", "type"]) &&
    SEATS.includes(value["seat"] as TableSeat)
  ) {
    return { type: "lobby/claim-seat", seat: value["seat"] as TableSeat };
  }
  if (
    (value["type"] === "lobby/leave-seat" ||
      value["type"] === "game/start" ||
      value["type"] === "game/draw" ||
      value["type"] === "game/declare-win") &&
    hasExactKeys(value, ["type"])
  ) {
    return { type: value["type"] };
  }
  if (
    value["type"] === "lobby/set-ready" &&
    hasExactKeys(value, ["ready", "type"]) &&
    typeof value["ready"] === "boolean"
  ) {
    return { type: "lobby/set-ready", ready: value["ready"] };
  }
  if (
    value["type"] === "game/discard" &&
    hasExactKeys(value, ["tileId", "type"]) &&
    isTileId(value["tileId"])
  ) {
    return { type: "game/discard", tileId: value["tileId"] };
  }
  if (
    value["type"] === "game/react" &&
    hasExactKeys(value, ["response", "type", "windowId"]) &&
    typeof value["windowId"] === "string" &&
    WINDOW_ID_PATTERN.test(value["windowId"])
  ) {
    const response = parseReactionResponse(value["response"]);
    return response === undefined
      ? undefined
      : { type: "game/react", response, windowId: value["windowId"] };
  }
  if (
    value["type"] === "game/declare-concealed-kong" &&
    hasExactKeys(value, ["tileIds", "type"])
  ) {
    const tileIds = tileTuple(value["tileIds"], 4);
    return tileIds === undefined || !sameStandardKind(tileIds)
      ? undefined
      : { type: "game/declare-concealed-kong", tileIds };
  }
  if (
    value["type"] === "game/propose-added-kong" &&
    hasExactKeys(value, ["meldId", "tileId", "type"]) &&
    typeof value["meldId"] === "string" &&
    MELD_ID_PATTERN.test(value["meldId"]) &&
    isTileId(value["tileId"])
  ) {
    return {
      type: "game/propose-added-kong",
      meldId: value["meldId"],
      tileId: value["tileId"],
    };
  }
  return undefined;
}

export function parseTableCommand(
  message: string,
): TableCommandEnvelope | undefined {
  try {
    const value = JSON.parse(message) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "command",
        "commandId",
        "expectedStateVersion",
        "protocolVersion",
        "type",
      ]) ||
      value["type"] !== "table/command" ||
      value["protocolVersion"] !== TABLE_PROTOCOL_VERSION ||
      typeof value["commandId"] !== "string" ||
      !COMMAND_ID_PATTERN.test(value["commandId"]) ||
      typeof value["expectedStateVersion"] !== "number" ||
      !Number.isSafeInteger(value["expectedStateVersion"]) ||
      value["expectedStateVersion"] < 0
    ) {
      return undefined;
    }
    const command = parseCommand(value["command"]);
    return command === undefined
      ? undefined
      : {
          command,
          commandId: value["commandId"],
          expectedStateVersion: value["expectedStateVersion"],
        };
  } catch {
    return undefined;
  }
}

export function parseTableResync(
  message: string,
): TableResyncEnvelope | undefined {
  try {
    const value = JSON.parse(message) as unknown;
    return isRecord(value) &&
      hasExactKeys(value, [
        "lastSeenStateVersion",
        "protocolVersion",
        "type",
      ]) &&
      value["type"] === "table/resync" &&
      value["protocolVersion"] === TABLE_PROTOCOL_VERSION &&
      typeof value["lastSeenStateVersion"] === "number" &&
      Number.isSafeInteger(value["lastSeenStateVersion"]) &&
      value["lastSeenStateVersion"] >= 0
      ? { lastSeenStateVersion: value["lastSeenStateVersion"] }
      : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalTableRequest(envelope: TableCommandEnvelope): string {
  return JSON.stringify({
    command: envelope.command,
    commandId: envelope.commandId,
    expectedStateVersion: envelope.expectedStateVersion,
    protocolVersion: TABLE_PROTOCOL_VERSION,
    type: "table/command",
  });
}

export function requestedTableProtocol(url: string): number | undefined {
  const values = new URL(url).searchParams.getAll("protocolVersion");
  if (values.length !== 1 || values[0] !== String(TABLE_PROTOCOL_VERSION)) {
    return undefined;
  }
  return TABLE_PROTOCOL_VERSION;
}

export function protocolUpgradeMessage(): string {
  return JSON.stringify({
    minimumSupportedVersion: TABLE_PROTOCOL_VERSION,
    protocolVersion: TABLE_PROTOCOL_VERSION,
    type: "table/upgrade-required",
  });
}
