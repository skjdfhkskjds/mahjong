import {
  assertCompletedHandResult,
  type CompletedHandResult,
} from "@mahjong/rules-hong-kong";

export const TABLE_PROTOCOL_VERSION = 2;

export type TableSeat = "east" | "south" | "west" | "north";

export interface TableActor {
  readonly id: string;
  readonly displayName: string;
}

export interface TableSeatView {
  readonly seat: TableSeat;
  readonly occupant: TableActor | null;
  readonly autopilot: boolean;
  readonly ready: boolean;
}

export interface PublicTileView {
  readonly id: number;
  readonly kind: Readonly<Record<string, unknown>>;
}

export interface PublicMeldView {
  readonly exposure: "concealed" | "exposed";
  readonly id: string;
  readonly kind: "chow" | "kong" | "pung";
  readonly tileIds: readonly PublicTileView[];
  readonly claimedTileId?: number;
  readonly kongKind?: "added" | "concealed" | "exposed";
  readonly sourceSeat?: TableSeat;
}

export type ReactionAction =
  | { readonly type: "pass" | "win" }
  | {
      readonly type: "chow" | "pung";
      readonly handTileIds: readonly [number, number];
    }
  | {
      readonly type: "kong";
      readonly handTileIds: readonly [number, number, number];
    };

export type TableGameCommand =
  | { readonly type: "game/start" }
  | { readonly type: "game/draw" }
  | { readonly type: "game/declare-win" }
  | { readonly type: "game/discard"; readonly tileId: number }
  | {
      readonly type: "game/react";
      readonly response: ReactionAction;
      readonly windowId: string;
    }
  | {
      readonly type: "game/declare-concealed-kong";
      readonly tileIds: readonly [number, number, number, number];
    }
  | {
      readonly type: "game/propose-added-kong";
      readonly meldId: string;
      readonly tileId: number;
    };

export type TableCommand =
  | { readonly type: "lobby/claim-seat"; readonly seat: TableSeat }
  | { readonly type: "lobby/leave-seat" }
  | { readonly type: "lobby/set-ready"; readonly ready: boolean }
  | TableGameCommand;

export type SelfTableCommand = Exclude<
  TableGameCommand,
  { readonly type: "game/start" | "game/react" }
>;

export interface TableCommandEnvelope {
  readonly type: "table/command";
  readonly protocolVersion: 2;
  readonly commandId: string;
  readonly expectedStateVersion: number;
  readonly command: TableCommand;
}

export interface GameView {
  readonly deadlineAt: number | null;
  readonly phase:
    | "awaiting-dealer-discard"
    | "awaiting-draw"
    | "awaiting-discard"
    | "awaiting-discard-reactions"
    | "awaiting-added-kong-reactions"
    | "complete"
    | "exhausted";
  readonly players: readonly {
    readonly bonuses: readonly PublicTileView[];
    readonly concealedCount: number;
    readonly discards: readonly PublicTileView[];
    readonly melds: readonly PublicMeldView[];
    readonly seat: TableSeat;
  }[];
  readonly reaction?: {
    readonly kind: "added-kong" | "discard";
    readonly sourceMeldId?: string;
    readonly sourceSeat: TableSeat;
    readonly sourceTile: PublicTileView;
    readonly windowId: string;
  };
  readonly result?: CompletedHandResult;
  readonly turn: TableSeat;
  readonly viewerActions?: {
    readonly reaction?: {
      readonly actions: readonly ReactionAction[];
      readonly status: "open" | "submitted";
      readonly windowId: string;
    };
    readonly self: readonly SelfTableCommand[];
  };
  readonly viewerHand?: readonly PublicTileView[];
  readonly wallRemaining: number;
}

export interface ViewerSafeTableSnapshot {
  readonly type: "table/snapshot";
  readonly protocolVersion: 2;
  readonly stateVersion: number;
  readonly view: {
    readonly phase:
      "abandoned" | "complete" | "exhausted" | "lobby" | "playing";
    readonly game?: GameView;
    readonly tableId: string;
    readonly seats: readonly TableSeatView[];
    readonly spectators: readonly TableActor[];
    readonly viewer:
      | {
          readonly actor: TableActor;
          readonly role: "player";
          readonly seat: TableSeat;
        }
      | { readonly actor: TableActor; readonly role: "spectator" };
  };
}

export interface TableReceipt {
  readonly type: "table/receipt";
  readonly protocolVersion: 2;
  readonly commandId: string;
  readonly stateVersion: number;
  readonly outcome: "applied" | "rejected";
  readonly error?: { readonly code: string; readonly message: string };
}

export type TableSocketMessage =
  | ViewerSafeTableSnapshot
  | TableReceipt
  | { readonly type: "session/replaced"; readonly protocolVersion: 2 }
  | {
      readonly type: "table/upgrade-required";
      readonly protocolVersion: 2;
      readonly minimumSupportedVersion: 2;
    };

const tableSeats = ["east", "south", "west", "north"] as const;
const commandIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const boundedIdPattern = /^[^\p{Cc}\p{Cf}]{1,96}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && boundedIdPattern.test(value);
}

function isTableSeat(value: unknown): value is TableSeat {
  return tableSeats.some((seat) => seat === value);
}

function nextSeat(value: TableSeat): TableSeat {
  switch (value) {
    case "east":
      return "south";
    case "south":
      return "west";
    case "west":
      return "north";
    case "north":
      return "east";
  }
}

function isTileId(value: unknown): value is number {
  return nonNegativeInteger(value) && value < 144;
}

function parseActor(value: unknown, field: string): TableActor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "displayName"]) ||
    !nonEmptyString(value["id"]) ||
    !nonEmptyString(value["displayName"])
  ) {
    throw new Error(`Table snapshot has an invalid ${field}.`);
  }
  return { id: value["id"], displayName: value["displayName"] };
}

function actorsEqual(left: TableActor, right: TableActor): boolean {
  return left.id === right.id && left.displayName === right.displayName;
}

function tileKindMatchesId(tile: PublicTileView): boolean {
  const { id, kind } = tile;
  if (id < 108) {
    const suits = ["characters", "circles", "bamboo"] as const;
    return (
      kind["type"] === "suited" &&
      kind["suit"] === suits[Math.floor(id / 36)] &&
      kind["rank"] === Math.floor((id % 36) / 4) + 1
    );
  }
  if (id < 124) {
    const winds = ["east", "south", "west", "north"] as const;
    return (
      kind["type"] === "wind" &&
      kind["wind"] === winds[Math.floor((id - 108) / 4)]
    );
  }
  if (id < 136) {
    const dragons = ["red", "green", "white"] as const;
    return (
      kind["type"] === "dragon" &&
      kind["dragon"] === dragons[Math.floor((id - 124) / 4)]
    );
  }
  const number = ((id - 136) % 4) + 1;
  const names = [
    "spring",
    "summer",
    "autumn",
    "winter",
    "plum",
    "orchid",
    "chrysanthemum",
    "bamboo",
  ] as const;
  return (
    kind["type"] === "bonus" &&
    kind["family"] === (id < 140 ? "season" : "flower") &&
    kind["name"] === names[id - 136] &&
    kind["number"] === number &&
    kind["matchingSeat"] === tableSeats[number - 1]
  );
}

function parsePublicTile(value: unknown): PublicTileView {
  const kind = isRecord(value) ? value["kind"] : undefined;
  const validKind =
    isRecord(kind) &&
    ((kind["type"] === "suited" &&
      hasExactKeys(kind, ["type", "suit", "rank"]) &&
      ["characters", "circles", "bamboo"].includes(kind["suit"] as string) &&
      Number.isSafeInteger(kind["rank"]) &&
      (kind["rank"] as number) >= 1 &&
      (kind["rank"] as number) <= 9) ||
      (kind["type"] === "wind" &&
        hasExactKeys(kind, ["type", "wind"]) &&
        isTableSeat(kind["wind"])) ||
      (kind["type"] === "dragon" &&
        hasExactKeys(kind, ["type", "dragon"]) &&
        ["red", "green", "white"].includes(kind["dragon"] as string)) ||
      (kind["type"] === "bonus" &&
        hasExactKeys(kind, [
          "type",
          "family",
          "name",
          "number",
          "matchingSeat",
        ]) &&
        (kind["family"] === "season" || kind["family"] === "flower") &&
        nonEmptyString(kind["name"]) &&
        Number.isSafeInteger(kind["number"]) &&
        (kind["number"] as number) >= 1 &&
        (kind["number"] as number) <= 4 &&
        isTableSeat(kind["matchingSeat"])));
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "kind"]) ||
    !isTileId(value["id"]) ||
    !validKind
  ) {
    throw new Error("Table game view has an invalid public tile.");
  }
  const tile = { id: value["id"], kind };
  if (!tileKindMatchesId(tile)) {
    throw new Error(
      "Table game view tile kind does not match its physical ID.",
    );
  }
  return tile;
}

function standardKindIndex(tileId: number): number | undefined {
  return tileId < 136 ? Math.floor(tileId / 4) : undefined;
}

function sameKind(tileIds: readonly number[]): boolean {
  const first = tileIds[0];
  return (
    first !== undefined &&
    standardKindIndex(first) !== undefined &&
    tileIds.every((id) => standardKindIndex(id) === standardKindIndex(first))
  );
}

function isChow(tileIds: readonly number[]): boolean {
  const kinds = tileIds
    .map(standardKindIndex)
    .sort((a, b) => (a ?? 99) - (b ?? 99));
  const [first, second, third] = kinds;
  return (
    first !== undefined &&
    second === first + 1 &&
    third === first + 2 &&
    first < 27 &&
    Math.floor(first / 9) === Math.floor(third / 9)
  );
}

function parseMeld(value: unknown): PublicMeldView {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["exposure", "id", "kind", "tileIds"],
      ["claimedTileId", "kongKind", "sourceSeat"],
    ) ||
    (value["exposure"] !== "concealed" && value["exposure"] !== "exposed") ||
    !boundedId(value["id"]) ||
    !["chow", "kong", "pung"].includes(value["kind"] as string) ||
    !Array.isArray(value["tileIds"])
  ) {
    throw new Error("Table game view has an invalid public meld.");
  }
  const tiles = value["tileIds"].map(parsePublicTile);
  const ids = tiles.map(({ id }) => id);
  const kind = value["kind"] as PublicMeldView["kind"];
  const expectedLength = kind === "kong" ? 4 : 3;
  const claimed = value["claimedTileId"];
  const source = value["sourceSeat"];
  const kongKind = value["kongKind"];
  if (
    tiles.length !== expectedLength ||
    new Set(ids).size !== ids.length ||
    (kind === "chow" ? !isChow(ids) : !sameKind(ids)) ||
    (claimed !== undefined && (!isTileId(claimed) || !ids.includes(claimed))) ||
    (source !== undefined && !isTableSeat(source)) ||
    (kind === "kong"
      ? !["added", "concealed", "exposed"].includes(kongKind as string)
      : kongKind !== undefined) ||
    (value["exposure"] === "concealed"
      ? kind !== "kong" ||
        kongKind !== "concealed" ||
        claimed !== undefined ||
        source !== undefined
      : claimed === undefined ||
        source === undefined ||
        kongKind === "concealed")
  ) {
    throw new Error("Table game view has an impossible public meld.");
  }
  return {
    exposure: value["exposure"],
    id: value["id"],
    kind,
    tileIds: tiles,
    ...(claimed === undefined ? {} : { claimedTileId: claimed }),
    ...(kongKind === undefined
      ? {}
      : {
          kongKind: kongKind as "added" | "concealed" | "exposed",
        }),
    ...(source === undefined ? {} : { sourceSeat: source }),
  };
}

function parseTileTuple(value: unknown, length: 2 | 3 | 4): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every(isTileId) ||
    value.some((id, index) => {
      const previous = value[index - 1];
      return previous !== undefined && id <= previous;
    })
  ) {
    throw new Error("Table action has invalid physical tile IDs.");
  }
  return value;
}

function parseReactionAction(value: unknown): ReactionAction {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Table game view has an invalid reaction action.");
  }
  if (
    (value["type"] === "pass" || value["type"] === "win") &&
    hasExactKeys(value, ["type"])
  ) {
    return { type: value["type"] };
  }
  if (
    (value["type"] === "chow" || value["type"] === "pung") &&
    hasExactKeys(value, ["type", "handTileIds"])
  ) {
    const ids = parseTileTuple(value["handTileIds"], 2) as readonly [
      number,
      number,
    ];
    if (value["type"] === "pung" && !sameKind(ids)) {
      throw new Error("Table game view has an impossible pung action.");
    }
    return { type: value["type"], handTileIds: ids };
  }
  if (
    value["type"] === "kong" &&
    hasExactKeys(value, ["type", "handTileIds"])
  ) {
    const ids = parseTileTuple(value["handTileIds"], 3) as readonly [
      number,
      number,
      number,
    ];
    if (!sameKind(ids))
      throw new Error("Table game view has an impossible kong action.");
    return { type: "kong", handTileIds: ids };
  }
  throw new Error("Table game view has an invalid reaction action.");
}

function sameTileIds(
  left: readonly number[],
  right: readonly number[],
): boolean {
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((id, index) => id === sortedRight[index])
  );
}

function completedResultPublicMismatch(
  result: CompletedHandResult,
  players: GameView["players"],
  viewerSeat: TableSeat | undefined,
  viewerHand: readonly PublicTileView[] | undefined,
): string | null {
  const winner = players.find(({ seat }) => seat === result.winnerSeat);
  if (winner === undefined) return "winner seat";
  if (winner.concealedCount !== result.winningHand.concealedTileIds.length)
    return "concealed count";
  if (
    !sameTileIds(
      winner.bonuses.map(({ id }) => id),
      result.winningHand.bonusTileIds,
    )
  )
    return "bonus tiles";
  if (winner.melds.length !== result.winningHand.declaredMelds.length)
    return "meld count";
  const publicMelds = new Map(winner.melds.map((meld) => [meld.id, meld]));
  if (
    result.winningHand.declaredMelds.some((meld) => {
      const projected = publicMelds.get(meld.id);
      if (projected === undefined) return true;
      return (
        projected.kind !== meld.kind ||
        projected.exposure !== meld.exposure ||
        projected.claimedTileId !== meld.claimedTileId ||
        projected.kongKind !== meld.kongKind ||
        projected.sourceSeat !== meld.sourceSeat ||
        !sameTileIds(
          projected.tileIds.map(({ id }) => id),
          meld.tileIds,
        )
      );
    })
  ) {
    return "meld provenance";
  }
  if (
    viewerSeat === result.winnerSeat &&
    (viewerHand === undefined ||
      !sameTileIds(
        viewerHand.map(({ id }) => id),
        result.winningHand.concealedTileIds,
      ))
  )
    return "winner hand";
  return null;
}

function parseSelfAction(value: unknown): SelfTableCommand {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    throw new Error("Table game view has an invalid self action.");
  }
  if (
    (value["type"] === "game/draw" || value["type"] === "game/declare-win") &&
    hasExactKeys(value, ["type"])
  ) {
    return { type: value["type"] };
  }
  if (
    value["type"] === "game/discard" &&
    hasExactKeys(value, ["type", "tileId"]) &&
    isTileId(value["tileId"])
  ) {
    return { type: "game/discard", tileId: value["tileId"] };
  }
  if (
    value["type"] === "game/declare-concealed-kong" &&
    hasExactKeys(value, ["type", "tileIds"])
  ) {
    const ids = parseTileTuple(value["tileIds"], 4) as readonly [
      number,
      number,
      number,
      number,
    ];
    if (!sameKind(ids))
      throw new Error(
        "Table game view has an impossible concealed kong action.",
      );
    return { type: "game/declare-concealed-kong", tileIds: ids };
  }
  if (
    value["type"] === "game/propose-added-kong" &&
    hasExactKeys(value, ["type", "meldId", "tileId"]) &&
    boundedId(value["meldId"]) &&
    isTileId(value["tileId"])
  ) {
    return {
      type: "game/propose-added-kong",
      meldId: value["meldId"],
      tileId: value["tileId"],
    };
  }
  throw new Error("Table game view has an invalid self action.");
}

function parseGameView(
  value: unknown,
  viewerSeat: TableSeat | undefined,
): GameView {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["deadlineAt", "phase", "players", "turn", "wallRemaining"],
      ["reaction", "result", "viewerActions", "viewerHand"],
    ) ||
    ![
      "awaiting-dealer-discard",
      "awaiting-draw",
      "awaiting-discard",
      "awaiting-discard-reactions",
      "awaiting-added-kong-reactions",
      "complete",
      "exhausted",
    ].includes(value["phase"] as string) ||
    !isTableSeat(value["turn"]) ||
    !nonNegativeInteger(value["wallRemaining"]) ||
    (value["deadlineAt"] !== null &&
      !nonNegativeInteger(value["deadlineAt"])) ||
    !Array.isArray(value["players"]) ||
    value["players"].length !== 4
  ) {
    throw new Error("Table snapshot has an invalid game view.");
  }
  const players = value["players"].map((player, index) => {
    if (
      !isRecord(player) ||
      !hasExactKeys(player, [
        "bonuses",
        "concealedCount",
        "discards",
        "melds",
        "seat",
      ]) ||
      player["seat"] !== tableSeats[index] ||
      !isTableSeat(player["seat"]) ||
      !nonNegativeInteger(player["concealedCount"]) ||
      player["concealedCount"] > 14 ||
      !Array.isArray(player["bonuses"]) ||
      !Array.isArray(player["discards"]) ||
      !Array.isArray(player["melds"]) ||
      player["bonuses"].length > 8 ||
      player["melds"].length > 4
    ) {
      throw new Error("Table snapshot has an invalid game player view.");
    }
    return {
      bonuses: player["bonuses"].map(parsePublicTile),
      concealedCount: player["concealedCount"],
      discards: player["discards"].map(parsePublicTile),
      melds: player["melds"].map(parseMeld),
      seat: player["seat"],
    };
  });
  const meldsWithOwners = players.flatMap((player) =>
    player.melds.map((meld) => ({ meld, owner: player.seat })),
  );
  if (
    new Set(meldsWithOwners.map(({ meld }) => meld.id)).size !==
      meldsWithOwners.length ||
    meldsWithOwners.some(
      ({ meld, owner }) =>
        meld.exposure === "exposed" && meld.sourceSeat === owner,
    )
  ) {
    throw new Error("Table snapshot has incoherent public meld identities.");
  }
  const viewerHand =
    value["viewerHand"] === undefined
      ? undefined
      : Array.isArray(value["viewerHand"])
        ? value["viewerHand"].map(parsePublicTile)
        : null;
  if (viewerHand === null)
    throw new Error("Table snapshot has an invalid private hand.");

  const reactionValue = value["reaction"];
  let reaction: GameView["reaction"];
  if (reactionValue !== undefined) {
    if (
      !isRecord(reactionValue) ||
      !hasExactKeys(
        reactionValue,
        ["kind", "sourceSeat", "sourceTile", "windowId"],
        ["sourceMeldId"],
      ) ||
      (reactionValue["kind"] !== "discard" &&
        reactionValue["kind"] !== "added-kong") ||
      !isTableSeat(reactionValue["sourceSeat"]) ||
      !boundedId(reactionValue["windowId"]) ||
      (reactionValue["kind"] === "added-kong") !==
        boundedId(reactionValue["sourceMeldId"])
    ) {
      throw new Error("Table snapshot has an invalid reaction window.");
    }
    const parsedReaction = {
      kind: reactionValue["kind"],
      sourceSeat: reactionValue["sourceSeat"],
      sourceTile: parsePublicTile(reactionValue["sourceTile"]),
      windowId: reactionValue["windowId"],
      ...(reactionValue["sourceMeldId"] === undefined
        ? {}
        : { sourceMeldId: reactionValue["sourceMeldId"] as string }),
    } satisfies NonNullable<GameView["reaction"]>;
    reaction = parsedReaction;
    const sourcePlayer = players.find(
      ({ seat }) => seat === parsedReaction.sourceSeat,
    );
    const sourceIsCoherent =
      parsedReaction.kind === "discard"
        ? sourcePlayer?.discards.at(-1)?.id === parsedReaction.sourceTile.id
        : sourcePlayer?.melds.some(
            (meld) =>
              meld.id === parsedReaction.sourceMeldId &&
              meld.kind === "pung" &&
              meld.exposure === "exposed" &&
              sameKind([
                ...meld.tileIds.map(({ id }) => id),
                parsedReaction.sourceTile.id,
              ]),
          ) === true;
    if (!sourceIsCoherent) {
      throw new Error("Table snapshot reaction source is incoherent.");
    }
    if (parsedReaction.kind === "added-kong") {
      const ownedVisibleIds = [
        ...players.flatMap(({ bonuses, discards, melds }) => [
          ...bonuses.map(({ id }) => id),
          ...discards.map(({ id }) => id),
          ...melds.flatMap(({ tileIds }) => tileIds.map(({ id }) => id)),
        ]),
        ...(viewerHand?.map(({ id }) => id) ?? []),
      ];
      if (ownedVisibleIds.includes(parsedReaction.sourceTile.id)) {
        throw new Error(
          "An added-kong source tile repeats visible tile ownership.",
        );
      }
    }
  }

  let result: CompletedHandResult | undefined;
  if (value["result"] !== undefined) {
    assertCompletedHandResult(value["result"]);
    result = value["result"];
  }

  const actionsValue = value["viewerActions"];
  let viewerActions: GameView["viewerActions"];
  if (actionsValue !== undefined) {
    if (
      !isRecord(actionsValue) ||
      !hasExactKeys(actionsValue, ["self"], ["reaction"]) ||
      !Array.isArray(actionsValue["self"])
    ) {
      throw new Error("Table snapshot has invalid private actions.");
    }
    const self = actionsValue["self"].map(parseSelfAction);
    if (
      new Set(self.map((action) => JSON.stringify(action))).size !== self.length
    ) {
      throw new Error("Table snapshot repeats a private self action.");
    }
    const reactionActions = actionsValue["reaction"];
    let ownReaction: NonNullable<GameView["viewerActions"]>["reaction"];
    if (reactionActions !== undefined) {
      if (
        !isRecord(reactionActions) ||
        !hasExactKeys(reactionActions, ["actions", "status", "windowId"]) ||
        !Array.isArray(reactionActions["actions"]) ||
        (reactionActions["status"] !== "open" &&
          reactionActions["status"] !== "submitted") ||
        !boundedId(reactionActions["windowId"])
      ) {
        throw new Error("Table snapshot has invalid private reaction actions.");
      }
      const actions = reactionActions["actions"].map(parseReactionAction);
      if (
        (reactionActions["status"] === "submitted" && actions.length !== 0) ||
        (reactionActions["status"] === "open" &&
          !actions.some(({ type }) => type === "pass")) ||
        new Set(actions.map((action) => JSON.stringify(action))).size !==
          actions.length
      ) {
        throw new Error(
          "Table snapshot has incoherent private reaction actions.",
        );
      }
      ownReaction = {
        actions,
        status: reactionActions["status"],
        windowId: reactionActions["windowId"],
      };
    }
    viewerActions = {
      self,
      ...(ownReaction === undefined ? {} : { reaction: ownReaction }),
    };
  }

  const phase = value["phase"] as GameView["phase"];
  const reactionPhase =
    phase === "awaiting-discard-reactions" ||
    phase === "awaiting-added-kong-reactions";
  if (
    reactionPhase !== (reaction !== undefined) ||
    (reaction !== undefined &&
      (phase === "awaiting-added-kong-reactions") !==
        (reaction.kind === "added-kong")) ||
    (phase === "complete") !== (result !== undefined) ||
    ((phase === "complete" || phase === "exhausted") &&
      value["deadlineAt"] !== null) ||
    (viewerActions?.reaction !== undefined &&
      viewerActions.reaction.windowId !== reaction?.windowId) ||
    (reactionPhase && (viewerActions?.self.length ?? 0) !== 0) ||
    (viewerActions?.self.some((action) =>
      action.type === "game/draw"
        ? phase !== "awaiting-draw"
        : phase !== "awaiting-discard" && phase !== "awaiting-dealer-discard",
    ) ??
      false)
  ) {
    throw new Error(
      "Table snapshot game phase or private actions are incoherent.",
    );
  }
  const resultMismatch =
    result === undefined
      ? null
      : completedResultPublicMismatch(result, players, viewerSeat, viewerHand);
  if (resultMismatch !== null) {
    throw new Error(
      `Completed result does not match its public winner projection (${resultMismatch}).`,
    );
  }
  if (viewerHand !== undefined && viewerActions !== undefined) {
    const handIds = new Set(viewerHand.map(({ id }) => id));
    const viewerMelds =
      players.find(({ seat }) => seat === viewerSeat)?.melds ?? [];
    for (const action of viewerActions.self) {
      if (action.type === "game/discard" && !handIds.has(action.tileId))
        throw new Error("A discard action references a hidden tile.");
      if (
        action.type === "game/declare-concealed-kong" &&
        !action.tileIds.every((id) => handIds.has(id))
      )
        throw new Error("A concealed kong action references a hidden tile.");
      if (
        action.type === "game/propose-added-kong" &&
        (!handIds.has(action.tileId) ||
          !viewerMelds.some(
            (meld) =>
              meld.id === action.meldId &&
              meld.kind === "pung" &&
              meld.exposure === "exposed" &&
              sameKind([...meld.tileIds.map(({ id }) => id), action.tileId]),
          ))
      )
        throw new Error("An added kong action references hidden state.");
    }
    const discardIds = viewerActions.self.flatMap((action) =>
      action.type === "game/discard" ? [action.tileId] : [],
    );
    const viewerOwnsTurn = viewerSeat === value["turn"];
    const shouldAdvertiseDiscards =
      viewerOwnsTurn &&
      (phase === "awaiting-discard" || phase === "awaiting-dealer-discard");
    if (
      (shouldAdvertiseDiscards &&
        (discardIds.length !== handIds.size ||
          discardIds.some((id) => !handIds.has(id)))) ||
      (!shouldAdvertiseDiscards && discardIds.length > 0)
    ) {
      throw new Error("Private discard actions do not cover the viewer hand.");
    }
    const drawActions = viewerActions.self.filter(
      ({ type }) => type === "game/draw",
    );
    if (
      viewerOwnsTurn && phase === "awaiting-draw"
        ? drawActions.length !== 1 || viewerActions.self.length !== 1
        : drawActions.length !== 0
    ) {
      throw new Error("Private draw actions do not match the viewer turn.");
    }
    for (const action of viewerActions.reaction?.actions ?? []) {
      if (
        reaction?.kind === "added-kong" &&
        action.type !== "pass" &&
        action.type !== "win"
      ) {
        throw new Error("An added-kong window advertises a discard claim.");
      }
      if ("handTileIds" in action) {
        if (!action.handTileIds.every((id) => handIds.has(id))) {
          throw new Error("A reaction action references a hidden tile.");
        }
        if (
          reaction !== undefined &&
          (action.type === "chow"
            ? viewerSeat !== nextSeat(reaction.sourceSeat) ||
              !isChow([...action.handTileIds, reaction.sourceTile.id])
            : !sameKind([...action.handTileIds, reaction.sourceTile.id]))
        ) {
          throw new Error(
            "A reaction action is impossible for its source tile.",
          );
        }
      }
    }
  }
  return {
    deadlineAt: value["deadlineAt"],
    phase,
    players,
    ...(reaction === undefined ? {} : { reaction }),
    ...(result === undefined ? {} : { result }),
    turn: value["turn"],
    ...(viewerActions === undefined ? {} : { viewerActions }),
    ...(viewerHand === undefined ? {} : { viewerHand }),
    wallRemaining: value["wallRemaining"],
  };
}

export function parseTableSnapshot(value: unknown): ViewerSafeTableSnapshot {
  if (
    !isRecord(value) ||
    value["type"] !== "table/snapshot" ||
    value["protocolVersion"] !== TABLE_PROTOCOL_VERSION ||
    !hasExactKeys(value, ["type", "protocolVersion", "stateVersion", "view"]) ||
    !nonNegativeInteger(value["stateVersion"])
  ) {
    throw new Error(
      "Table socket message is not a canonical protocol v2 snapshot.",
    );
  }
  const view = value["view"];
  if (
    !isRecord(view) ||
    !["abandoned", "complete", "exhausted", "lobby", "playing"].includes(
      view["phase"] as string,
    ) ||
    !hasExactKeys(
      view,
      ["phase", "tableId", "seats", "spectators", "viewer"],
      ["game"],
    ) ||
    !nonEmptyString(view["tableId"]) ||
    !Array.isArray(view["seats"]) ||
    view["seats"].length !== 4 ||
    !Array.isArray(view["spectators"])
  ) {
    throw new Error("Table snapshot has an invalid view.");
  }
  const seats = view["seats"].map((seat, index): TableSeatView => {
    if (
      !isRecord(seat) ||
      !hasExactKeys(seat, ["seat", "occupant", "autopilot", "ready"]) ||
      seat["seat"] !== tableSeats[index] ||
      !isTableSeat(seat["seat"]) ||
      typeof seat["autopilot"] !== "boolean" ||
      typeof seat["ready"] !== "boolean"
    )
      throw new Error("Table snapshot has invalid or non-canonical seats.");
    const occupant =
      seat["occupant"] === null
        ? null
        : parseActor(seat["occupant"], "seat occupant");
    if (occupant === null && (seat["ready"] || seat["autopilot"]))
      throw new Error("An empty table seat cannot be ready or automated.");
    return {
      seat: seat["seat"],
      occupant,
      autopilot: seat["autopilot"],
      ready: seat["ready"],
    };
  });
  const spectators = view["spectators"].map((actor) =>
    parseActor(actor, "spectator"),
  );
  const identities = [
    ...seats.flatMap(({ occupant }) => (occupant ? [occupant.id] : [])),
    ...spectators.map(({ id }) => id),
  ];
  if (new Set(identities).size !== identities.length)
    throw new Error("Table snapshot contains duplicate actor identities.");

  const viewerValue = view["viewer"];
  if (!isRecord(viewerValue))
    throw new Error("Table snapshot is missing its viewer.");
  const actor = parseActor(viewerValue["actor"], "viewer actor");
  let viewer: ViewerSafeTableSnapshot["view"]["viewer"];
  if (
    viewerValue["role"] === "player" &&
    hasExactKeys(viewerValue, ["actor", "role", "seat"]) &&
    isTableSeat(viewerValue["seat"])
  ) {
    const ownSeat = seats.find(({ seat }) => seat === viewerValue["seat"]);
    if (!ownSeat?.occupant || !actorsEqual(ownSeat.occupant, actor))
      throw new Error("Table snapshot player viewer does not match its seat.");
    viewer = { actor, role: "player", seat: viewerValue["seat"] };
  } else if (
    viewerValue["role"] === "spectator" &&
    hasExactKeys(viewerValue, ["actor", "role"]) &&
    spectators.some((candidate) => actorsEqual(candidate, actor))
  ) {
    viewer = { actor, role: "spectator" };
  } else throw new Error("Table snapshot has an invalid viewer role or seat.");

  const phase = view["phase"] as ViewerSafeTableSnapshot["view"]["phase"];
  const game =
    view["game"] === undefined
      ? undefined
      : parseGameView(
          view["game"],
          viewer.role === "player" ? viewer.seat : undefined,
        );
  if (
    (phase === "lobby" && game !== undefined) ||
    (phase !== "lobby" && phase !== "abandoned" && game === undefined) ||
    (phase === "complete" && game?.phase !== "complete") ||
    (game?.phase === "complete" &&
      phase !== "complete" &&
      phase !== "abandoned") ||
    (phase === "exhausted" && game?.phase !== "exhausted") ||
    (game?.phase === "exhausted" &&
      phase !== "exhausted" &&
      phase !== "abandoned") ||
    (phase === "playing" &&
      (game?.phase === "complete" || game?.phase === "exhausted")) ||
    (viewer.role === "spectator" &&
      (game?.viewerHand !== undefined || game?.viewerActions !== undefined)) ||
    (viewer.role === "player" &&
      game !== undefined &&
      (game.viewerHand === undefined || game.viewerActions === undefined))
  )
    throw new Error("Table snapshot game phase or private data is incoherent.");
  if (viewer.role === "player" && game !== undefined) {
    const own = game.players.find(({ seat }) => seat === viewer.seat);
    if (own === undefined || own.concealedCount !== game.viewerHand?.length)
      throw new Error("Table snapshot private hand count is incoherent.");
    const shouldHaveReaction =
      game.reaction !== undefined && game.reaction.sourceSeat !== viewer.seat;
    if (
      shouldHaveReaction !== (game.viewerActions?.reaction !== undefined) ||
      (viewer.seat !== game.turn && (game.viewerActions?.self.length ?? 0) > 0)
    ) {
      throw new Error(
        "Table snapshot private actions do not belong to the viewer.",
      );
    }
  }
  if (game !== undefined) {
    const visibleIds = [
      ...game.players.flatMap(({ bonuses, discards, melds }) => [
        ...bonuses.map(({ id }) => id),
        ...discards.map(({ id }) => id),
        ...melds.flatMap(({ tileIds }) => tileIds.map(({ id }) => id)),
      ]),
      ...(game.viewerHand?.map(({ id }) => id) ?? []),
    ];
    if (new Set(visibleIds).size !== visibleIds.length)
      throw new Error("Table snapshot repeats a visible physical tile ID.");
  }
  return {
    type: "table/snapshot",
    protocolVersion: TABLE_PROTOCOL_VERSION,
    stateVersion: value["stateVersion"],
    view: {
      phase,
      ...(game === undefined ? {} : { game }),
      tableId: view["tableId"],
      seats,
      spectators,
      viewer,
    },
  };
}

export function parseTableReceipt(value: unknown): TableReceipt {
  if (
    !isRecord(value) ||
    value["type"] !== "table/receipt" ||
    value["protocolVersion"] !== TABLE_PROTOCOL_VERSION ||
    !hasExactKeys(
      value,
      ["type", "protocolVersion", "commandId", "stateVersion", "outcome"],
      ["error"],
    ) ||
    typeof value["commandId"] !== "string" ||
    !commandIdPattern.test(value["commandId"]) ||
    !nonNegativeInteger(value["stateVersion"])
  )
    throw new Error("Table socket message is not a canonical receipt.");
  if (value["outcome"] === "applied" && value["error"] === undefined)
    return {
      type: "table/receipt",
      protocolVersion: 2,
      commandId: value["commandId"],
      stateVersion: value["stateVersion"],
      outcome: "applied",
    };
  const error = value["error"];
  if (
    value["outcome"] !== "rejected" ||
    !isRecord(error) ||
    !hasExactKeys(error, ["code", "message"]) ||
    !nonEmptyString(error["code"]) ||
    !nonEmptyString(error["message"])
  )
    throw new Error("Table receipt has an invalid outcome or error.");
  return {
    type: "table/receipt",
    protocolVersion: 2,
    commandId: value["commandId"],
    stateVersion: value["stateVersion"],
    outcome: "rejected",
    error: { code: error["code"], message: error["message"] },
  };
}

export function parseSocketMessage(
  event: MessageEvent<unknown>,
): TableSocketMessage {
  if (typeof event.data !== "string")
    throw new Error("Table socket messages must be JSON text.");
  let value: unknown;
  try {
    value = JSON.parse(event.data) as unknown;
  } catch (error) {
    throw new Error("Table socket message is not valid JSON.", {
      cause: error,
    });
  }
  if (
    isRecord(value) &&
    value["type"] === "session/replaced" &&
    value["protocolVersion"] === 2 &&
    hasExactKeys(value, ["type", "protocolVersion"])
  )
    return { type: "session/replaced", protocolVersion: 2 };
  if (
    isRecord(value) &&
    value["type"] === "table/upgrade-required" &&
    value["protocolVersion"] === 2 &&
    value["minimumSupportedVersion"] === 2 &&
    hasExactKeys(value, ["type", "protocolVersion", "minimumSupportedVersion"])
  )
    return {
      type: "table/upgrade-required",
      protocolVersion: 2,
      minimumSupportedVersion: 2,
    };
  if (isRecord(value) && value["type"] === "table/receipt")
    return parseTableReceipt(value);
  return parseTableSnapshot(value);
}

export function validateCommand(
  envelope: unknown,
): asserts envelope is TableCommandEnvelope {
  if (
    !isRecord(envelope) ||
    !hasExactKeys(envelope, [
      "type",
      "protocolVersion",
      "commandId",
      "expectedStateVersion",
      "command",
    ]) ||
    envelope["type"] !== "table/command" ||
    envelope["protocolVersion"] !== 2 ||
    typeof envelope["commandId"] !== "string" ||
    !commandIdPattern.test(envelope["commandId"]) ||
    !nonNegativeInteger(envelope["expectedStateVersion"]) ||
    !isRecord(envelope["command"])
  )
    throw new Error("Table command is not a canonical envelope.");
  const body = envelope["command"];
  switch (body["type"]) {
    case "lobby/claim-seat":
      if (hasExactKeys(body, ["type", "seat"]) && isTableSeat(body["seat"]))
        return;
      break;
    case "lobby/leave-seat":
    case "game/start":
    case "game/draw":
    case "game/declare-win":
      if (hasExactKeys(body, ["type"])) return;
      break;
    case "lobby/set-ready":
      if (
        hasExactKeys(body, ["type", "ready"]) &&
        typeof body["ready"] === "boolean"
      )
        return;
      break;
    case "game/discard":
      if (hasExactKeys(body, ["type", "tileId"]) && isTileId(body["tileId"]))
        return;
      break;
    case "game/react":
      if (
        hasExactKeys(body, ["type", "windowId", "response"]) &&
        boundedId(body["windowId"])
      ) {
        parseReactionAction(body["response"]);
        return;
      }
      break;
    case "game/declare-concealed-kong":
      if (
        hasExactKeys(body, ["type", "tileIds"]) &&
        sameKind(parseTileTuple(body["tileIds"], 4))
      )
        return;
      break;
    case "game/propose-added-kong":
      if (
        hasExactKeys(body, ["type", "meldId", "tileId"]) &&
        boundedId(body["meldId"]) &&
        isTileId(body["tileId"])
      )
        return;
      break;
  }
  throw new Error("Table command has an invalid command body.");
}
