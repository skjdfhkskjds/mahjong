import {
  nextSeat,
  seat,
  seats,
  type Seat,
  type TileId,
} from "@mahjong/game-core";

import { initialDealSeatOrder } from "../setup/initial-deal.js";
import type { HongKongTileKind } from "../tiles/hong-kong-tile-kind.js";
import { createHongKongV1TileSet } from "../wall/create-tile-set.js";
import {
  deterministicShuffle,
  HONG_KONG_V1_SHUFFLE_ALGORITHM,
  selectInitialDealerPosition,
} from "../wall/deterministic-shuffle.js";

export type GamePhase =
  | "awaiting-dealer-discard"
  | "awaiting-draw"
  | "awaiting-discard"
  | "exhausted";

export interface CanonicalPlayerState {
  readonly actorId: string;
  readonly bonuses: readonly TileId[];
  readonly discards: readonly TileId[];
  readonly hand: readonly TileId[];
  readonly seat: Seat;
}

export interface SeatMap<Value> {
  readonly east: Value;
  readonly south: Value;
  readonly west: Value;
  readonly north: Value;
}

export interface CanonicalGameState {
  readonly phase: GamePhase;
  readonly players: SeatMap<CanonicalPlayerState>;
  readonly ruleset: "hong-kong/v1";
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly shuffleAlgorithm: typeof HONG_KONG_V1_SHUFFLE_ALGORITHM;
  readonly turn: Seat;
  readonly wall: {
    readonly head: number;
    readonly order: readonly TileId[];
    readonly tail: number;
  };
}

interface StartedEvent {
  readonly type: "game/started";
  readonly sequence: 1;
  readonly state: CanonicalGameState;
}

interface DiscardedEvent {
  readonly type: "game/tile-discarded";
  readonly sequence: number;
  readonly seat: Seat;
  readonly tileId: TileId;
}

interface DrawnEvent {
  readonly type: "game/turn-drawn";
  readonly sequence: number;
  readonly seat: Seat;
  readonly ordinaryTileId: TileId;
  readonly replacementTileIds: readonly TileId[];
  readonly exhausted: boolean;
}

interface ExhaustedEvent {
  readonly type: "game/wall-exhausted";
  readonly sequence: number;
  readonly seat: Seat;
  readonly requiredDraw: "ordinary";
}

export type HongKongGameEvent =
  StartedEvent | DiscardedEvent | DrawnEvent | ExhaustedEvent;

export type HongKongGameCommand =
  | { readonly type: "game/draw" }
  | { readonly type: "game/discard"; readonly tileId: TileId };

export type GameDecision =
  | { readonly accepted: true; readonly event: HongKongGameEvent }
  | {
      readonly accepted: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface PublicTile {
  readonly id: TileId;
  readonly kind: HongKongTileKind;
}

export interface GameView {
  readonly phase: GamePhase;
  readonly players: readonly {
    readonly bonuses: readonly PublicTile[];
    readonly concealedCount: number;
    readonly discards: readonly PublicTile[];
    readonly seat: Seat;
  }[];
  readonly turn: Seat;
  readonly viewerHand?: readonly PublicTile[];
  readonly wallRemaining: number;
}

const inventory = createHongKongV1TileSet();
const tilesById = new Map(inventory.map((tile) => [tile.id, tile]));

function isBonus(id: TileId): boolean {
  return tilesById.get(id)?.kind.type === "bonus";
}

function emptyPlayers(actors: SeatMap<string>): SeatMap<CanonicalPlayerState> {
  return Object.fromEntries(
    seats.map((seat) => [
      seat,
      {
        actorId: actors[seatName(seat)],
        bonuses: [],
        discards: [],
        hand: [],
        seat,
      },
    ]),
  ) as unknown as SeatMap<CanonicalPlayerState>;
}

function replacePlayer(
  state: CanonicalGameState,
  seat: Seat,
  player: CanonicalPlayerState,
): SeatMap<CanonicalPlayerState> {
  return { ...state.players, [seatName(seat)]: player };
}

type SeatName = keyof SeatMap<unknown>;

function seatName(value: Seat): SeatName {
  return value;
}

function playerAt<Value>(players: SeatMap<Value>, value: Seat): Value {
  return players[seatName(value)];
}

export function startHongKongV1Game(
  stablePositions: SeatMap<string>,
  randomness: Uint8Array,
): { readonly event: StartedEvent; readonly state: CanonicalGameState } {
  if (new Set(Object.values(stablePositions)).size !== seats.length) {
    throw new TypeError("A game requires four distinct seated actors.");
  }
  const order = deterministicShuffle(inventory, randomness).map(({ id }) => id);
  // Stable lobby positions are rotated onto winds by one uniform selection.
  // The 144 canonical IDs contain 36 values in each residue class modulo four.
  const dealerPosition = selectInitialDealerPosition(randomness);
  const actors = Object.fromEntries(
    seats.map((wind, offset) => {
      const position = seats[(dealerPosition + offset) % seats.length];
      if (position === undefined) throw new Error("Invalid dealer position.");
      return [wind, stablePositions[seatName(position)]];
    }),
  ) as unknown as SeatMap<string>;
  const basePlayers = emptyPlayers(actors);
  const mutable = Object.fromEntries(
    seats.map((currentSeat) => {
      const player = playerAt(basePlayers, currentSeat);
      return [
        currentSeat,
        { ...player, bonuses: [...player.bonuses], hand: [...player.hand] },
      ];
    }),
  ) as unknown as SeatMap<
    CanonicalPlayerState & { bonuses: TileId[]; hand: TileId[] }
  >;
  const acquired = Object.fromEntries(
    seats.map((seat) => [seat, [] as TileId[]]),
  ) as unknown as SeatMap<TileId[]>;
  let head = 0;
  let tail = order.length - 1;
  for (const assignedSeat of initialDealSeatOrder) {
    const id = order[head];
    if (id === undefined || head > tail)
      throw new Error("Wall exhausted during initial deal.");
    head += 1;
    playerAt(acquired, assignedSeat).push(id);
  }
  let exhausted = false;
  for (const currentSeat of seats) {
    for (const dealtId of playerAt(acquired, currentSeat)) {
      let id: TileId | undefined = dealtId;
      while (id !== undefined && isBonus(id)) {
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
  const state: CanonicalGameState = {
    phase: exhausted ? "exhausted" : "awaiting-dealer-discard",
    players: mutable,
    ruleset: "hong-kong/v1",
    schemaVersion: 1,
    sequence: 1,
    shuffleAlgorithm: HONG_KONG_V1_SHUFFLE_ALGORITHM,
    turn: seat("east"),
    wall: { head, order, tail },
  };
  assertGameInvariants(state);
  return { event: { type: "game/started", sequence: 1, state }, state };
}

function rejected(code: string, message: string): GameDecision {
  return { accepted: false, error: { code, message } };
}

export function decideGameCommand(
  state: CanonicalGameState,
  actorId: string,
  command: HongKongGameCommand,
): GameDecision {
  const player = seats
    .map((seat) => playerAt(state.players, seat))
    .find((value) => value.actorId === actorId);
  if (player === undefined)
    return rejected("spectator-cannot-play", "Only a seated player can act.");
  if (state.phase === "exhausted")
    return rejected("game-exhausted", "The wall is exhausted.");
  if (player.seat !== state.turn)
    return rejected("not-your-turn", "Another player has the turn.");
  if (command.type === "game/draw") {
    if (state.phase !== "awaiting-draw")
      return rejected(
        "draw-not-allowed",
        "A draw is not allowed in this phase.",
      );
    const ordinaryTileId = state.wall.order[state.wall.head];
    if (ordinaryTileId === undefined || state.wall.head > state.wall.tail) {
      return {
        accepted: true,
        event: {
          type: "game/wall-exhausted",
          sequence: state.sequence + 1,
          seat: player.seat,
          requiredDraw: "ordinary",
        },
      };
    }
    const replacementTileIds: TileId[] = [];
    let tail = state.wall.tail;
    if (isBonus(ordinaryTileId)) {
      while (tail >= state.wall.head + 1) {
        const replacement = state.wall.order[tail];
        if (replacement === undefined) break;
        replacementTileIds.push(replacement);
        tail -= 1;
        if (!isBonus(replacement)) break;
      }
    }
    const final = replacementTileIds.at(-1) ?? ordinaryTileId;
    return {
      accepted: true,
      event: {
        type: "game/turn-drawn",
        sequence: state.sequence + 1,
        seat: player.seat,
        ordinaryTileId,
        replacementTileIds,
        exhausted: isBonus(final),
      },
    };
  }
  if (
    state.phase !== "awaiting-dealer-discard" &&
    state.phase !== "awaiting-discard"
  ) {
    return rejected(
      "discard-not-allowed",
      "A discard is not allowed in this phase.",
    );
  }
  if (!player.hand.includes(command.tileId)) {
    return rejected(
      "tile-not-in-hand",
      "That physical tile is not in the player's hand.",
    );
  }
  return {
    accepted: true,
    event: {
      type: "game/tile-discarded",
      sequence: state.sequence + 1,
      seat: player.seat,
      tileId: command.tileId,
    },
  };
}

export function reduceGameEvent(
  state: CanonicalGameState | undefined,
  event: HongKongGameEvent,
): CanonicalGameState {
  assertGameEvent(event);
  if (event.type === "game/started") {
    if (state !== undefined || event.state.sequence !== 1)
      throw new Error("Invalid game genesis event.");
    assertGameInvariants(event.state);
    return event.state;
  }
  if (state === undefined || event.sequence !== state.sequence + 1)
    throw new Error("Non-contiguous game event sequence.");
  let next: CanonicalGameState;
  if (event.type === "game/wall-exhausted") {
    if (
      state.phase !== "awaiting-draw" ||
      event.seat !== state.turn ||
      state.wall.head <= state.wall.tail
    ) {
      throw new Error(
        "Exhaustion event is not required by the canonical wall.",
      );
    }
    next = { ...state, phase: "exhausted", sequence: event.sequence };
  } else if (event.type === "game/tile-discarded") {
    if (
      (state.phase !== "awaiting-dealer-discard" &&
        state.phase !== "awaiting-discard") ||
      event.seat !== state.turn
    )
      throw new Error("Discard event has the wrong seat.");
    const player = playerAt(state.players, event.seat);
    const index = player.hand.indexOf(event.tileId);
    if (index < 0)
      throw new Error("Discard event references a tile outside the hand.");
    next = {
      ...state,
      phase: "awaiting-draw",
      players: replacePlayer(state, event.seat, {
        ...player,
        hand: player.hand.filter((_, tileIndex) => tileIndex !== index),
        discards: [...player.discards, event.tileId],
      }),
      sequence: event.sequence,
      turn: nextSeat(event.seat),
    };
  } else {
    if (
      state.phase !== "awaiting-draw" ||
      event.seat !== state.turn ||
      event.ordinaryTileId !== state.wall.order[state.wall.head]
    ) {
      throw new Error("Draw event does not match the canonical wall.");
    }
    let tail = state.wall.tail;
    let replacementRequired = isBonus(event.ordinaryTileId);
    for (const replacement of event.replacementTileIds) {
      if (!replacementRequired)
        throw new Error("Replacement chain continues after a structural tile.");
      if (replacement !== state.wall.order[tail])
        throw new Error("Replacement draw does not match the wall tail.");
      tail -= 1;
      replacementRequired = isBonus(replacement);
    }
    if (
      replacementRequired !== event.exhausted ||
      (replacementRequired && tail >= state.wall.head + 1)
    ) {
      throw new Error(
        "Draw event does not contain the exact replacement chain.",
      );
    }
    const drawn = [event.ordinaryTileId, ...event.replacementTileIds];
    const bonuses = drawn.filter(isBonus);
    const structural = drawn.filter((id) => !isBonus(id));
    if (
      (!event.exhausted && structural.length !== 1) ||
      (event.exhausted && structural.length !== 0)
    ) {
      throw new Error("Draw event has an invalid replacement outcome.");
    }
    const player = playerAt(state.players, event.seat);
    next = {
      ...state,
      phase: event.exhausted ? "exhausted" : "awaiting-discard",
      players: replacePlayer(state, event.seat, {
        ...player,
        bonuses: [...player.bonuses, ...bonuses],
        hand: [...player.hand, ...structural],
      }),
      sequence: event.sequence,
      wall: { ...state.wall, head: state.wall.head + 1, tail },
    };
  }
  assertGameInvariants(next);
  return next;
}

export function applyGameCommand(
  state: CanonicalGameState,
  actorId: string,
  command: HongKongGameCommand,
): GameDecision & { readonly state?: CanonicalGameState } {
  const decision = decideGameCommand(state, actorId, command);
  return decision.accepted
    ? { ...decision, state: reduceGameEvent(state, decision.event) }
    : decision;
}

export function replayGameEvents(
  events: readonly HongKongGameEvent[],
): CanonicalGameState {
  let state: CanonicalGameState | undefined;
  for (const event of events) state = reduceGameEvent(state, event);
  if (state === undefined)
    throw new Error("A game event stream must contain genesis.");
  return state;
}

export function projectGame(
  state: CanonicalGameState,
  viewerActorId: string,
): GameView {
  const viewer = seats
    .map((seat) => playerAt(state.players, seat))
    .find(({ actorId }) => actorId === viewerActorId);
  const publicTile = (id: TileId): PublicTile => {
    const tile = tilesById.get(id);
    if (tile === undefined) throw new Error("Unknown physical tile ID.");
    return tile;
  };
  return {
    phase: state.phase,
    players: seats.map((seat) => {
      const player = playerAt(state.players, seat);
      return {
        bonuses: player.bonuses.map(publicTile),
        concealedCount: player.hand.length,
        discards: player.discards.map(publicTile),
        seat,
      };
    }),
    turn: state.turn,
    ...(viewer === undefined
      ? {}
      : { viewerHand: viewer.hand.map(publicTile) }),
    wallRemaining: Math.max(0, state.wall.tail - state.wall.head + 1),
  };
}

export function canonicalGameJson(state: CanonicalGameState): string {
  assertGameInvariants(state);
  return canonicalJson(state);
}

export function decodeCanonicalGameJson(value: string): CanonicalGameState {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed))
    throw new Error("Canonical game state must be an object.");
  const state = parsed as unknown as CanonicalGameState;
  assertGameInvariants(state);
  if (canonicalGameJson(state) !== value)
    throw new Error("Canonical game state bytes are not canonical.");
  return state;
}

export function canonicalGameEventJson(event: HongKongGameEvent): string {
  assertGameEvent(event);
  return canonicalJson(event);
}

export function decodeCanonicalGameEventJson(value: string): HongKongGameEvent {
  const parsed = JSON.parse(value) as unknown;
  assertGameEvent(parsed);
  if (canonicalGameEventJson(parsed) !== value)
    throw new Error("Canonical game event bytes are not canonical.");
  return parsed;
}

export function canonicalEventHashPayload(
  previousHash: string | null,
  event: HongKongGameEvent,
): string {
  assertGameEvent(event);
  if (previousHash !== null && !/^[0-9a-f]{64}$/u.test(previousHash)) {
    throw new TypeError(
      "Previous event hash must be null or lowercase SHA-256.",
    );
  }
  return canonicalJson({ event, previousHash, version: 1 });
}

export function assertGameInvariants(
  value: unknown,
): asserts value is CanonicalGameState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "phase",
      "players",
      "ruleset",
      "schemaVersion",
      "sequence",
      "shuffleAlgorithm",
      "turn",
      "wall",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["ruleset"] !== "hong-kong/v1" ||
    value["shuffleAlgorithm"] !== HONG_KONG_V1_SHUFFLE_ALGORITHM ||
    !(
      [
        "awaiting-dealer-discard",
        "awaiting-draw",
        "awaiting-discard",
        "exhausted",
      ] as const
    ).includes(value["phase"] as GamePhase) ||
    !seats.includes(value["turn"] as Seat)
  ) {
    throw new Error("Unsupported canonical game encoding.");
  }
  const state = value as unknown as CanonicalGameState;
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 1)
    throw new Error("Invalid event sequence.");
  const wallValue: unknown = state.wall;
  if (
    !isRecord(wallValue) ||
    !hasExactKeys(wallValue, ["head", "order", "tail"]) ||
    !Array.isArray(state.wall.order) ||
    !Number.isSafeInteger(state.wall.head) ||
    !Number.isSafeInteger(state.wall.tail) ||
    state.wall.order.length !== 144 ||
    state.wall.head < 0 ||
    state.wall.tail >= 144 ||
    state.wall.head > state.wall.tail + 1
  ) {
    throw new Error("Invalid wall bounds.");
  }
  const orderIds = state.wall.order;
  if (
    new Set(orderIds).size !== 144 ||
    orderIds.some((id) => !Number.isSafeInteger(id) || id < 0 || id >= 144)
  )
    throw new Error("Wall must contain every physical tile exactly once.");
  if (!isRecord(state.players) || !hasExactKeys(state.players, seats)) {
    throw new Error("Canonical players must contain exactly four seats.");
  }
  for (const currentSeat of seats) {
    const candidate = (state.players as unknown as Record<string, unknown>)[
      seatName(currentSeat)
    ];
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "actorId",
        "bonuses",
        "discards",
        "hand",
        "seat",
      ]) ||
      typeof candidate["actorId"] !== "string" ||
      candidate["actorId"].length === 0 ||
      !Array.isArray(candidate["bonuses"]) ||
      !Array.isArray(candidate["discards"]) ||
      !Array.isArray(candidate["hand"]) ||
      candidate["seat"] !== currentSeat ||
      candidate["bonuses"].some(
        (id) => !Number.isSafeInteger(id) || !isBonus(id as TileId),
      ) ||
      candidate["hand"].some(
        (id) => !Number.isSafeInteger(id) || isBonus(id as TileId),
      ) ||
      candidate["discards"].some(
        (id) => !Number.isSafeInteger(id) || isBonus(id as TileId),
      )
    ) {
      throw new Error(
        "Player tile locations violate kind or seat constraints.",
      );
    }
  }
  const canonicalWallOrder: readonly TileId[] = state.wall.order;
  const locations = [
    ...canonicalWallOrder.slice(state.wall.head, state.wall.tail + 1),
    ...seats.flatMap((seat) => {
      const player = playerAt(state.players, seat);
      return [...player.hand, ...player.bonuses, ...player.discards];
    }),
  ];
  if (locations.length !== 144 || new Set(locations.map(Number)).size !== 144)
    throw new Error("Every physical tile must occupy exactly one location.");
  if (
    new Set(seats.map((seat) => playerAt(state.players, seat).actorId)).size !==
    4
  )
    throw new Error("Players must be distinct.");
  if (state.phase !== "exhausted") {
    const expected =
      state.phase === "awaiting-discard" ||
      state.phase === "awaiting-dealer-discard"
        ? 14
        : 13;
    if (playerAt(state.players, state.turn).hand.length !== expected)
      throw new Error("Turn hand size does not match the phase.");
    for (const currentSeat of seats) {
      if (
        currentSeat !== state.turn &&
        playerAt(state.players, currentSeat).hand.length !== 13
      )
        throw new Error("Inactive player must hold 13 structural tiles.");
    }
  } else if (state.wall.head !== state.wall.tail + 1) {
    throw new Error("An exhausted game must have no drawable wall tiles.");
  } else if (
    seats.some(
      (currentSeat) => playerAt(state.players, currentSeat).hand.length !== 13,
    )
  ) {
    throw new Error(
      "An exhausted game must leave 13 structural tiles per seat.",
    );
  }
}

function assertGameEvent(value: unknown): asserts value is HongKongGameEvent {
  if (!isRecord(value) || typeof value["type"] !== "string")
    throw new Error("Canonical game event must be an object.");
  const sequence = value["sequence"];
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1)
    throw new Error("Canonical game event has an invalid sequence.");
  if (value["type"] === "game/started") {
    if (!hasExactKeys(value, ["sequence", "state", "type"]) || sequence !== 1)
      throw new Error("Canonical genesis event is invalid.");
    assertGameInvariants(value["state"]);
    if (value["state"].sequence !== 1)
      throw new Error("Canonical genesis state must have sequence one.");
    return;
  }
  if (value["type"] === "game/tile-discarded") {
    if (
      !hasExactKeys(value, ["seat", "sequence", "tileId", "type"]) ||
      !seats.includes(value["seat"] as Seat) ||
      !validTileId(value["tileId"])
    )
      throw new Error("Canonical discard event is invalid.");
    return;
  }
  if (value["type"] === "game/wall-exhausted") {
    if (
      !hasExactKeys(value, ["requiredDraw", "seat", "sequence", "type"]) ||
      value["requiredDraw"] !== "ordinary" ||
      !seats.includes(value["seat"] as Seat)
    )
      throw new Error("Canonical exhaustion event is invalid.");
    return;
  }
  if (
    value["type"] !== "game/turn-drawn" ||
    !hasExactKeys(value, [
      "exhausted",
      "ordinaryTileId",
      "replacementTileIds",
      "seat",
      "sequence",
      "type",
    ]) ||
    typeof value["exhausted"] !== "boolean" ||
    !validTileId(value["ordinaryTileId"]) ||
    !Array.isArray(value["replacementTileIds"]) ||
    value["replacementTileIds"].some((id) => !validTileId(id)) ||
    !seats.includes(value["seat"] as Seat)
  )
    throw new Error("Canonical draw event is invalid.");
}

function validTileId(value: unknown): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < 144
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON requires finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON contains an unsupported value.");
}
