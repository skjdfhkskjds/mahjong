import type {
  PublicTileView,
  ReactionAction,
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";
import { mapPlayerIdentity } from "../players/player-display.js";
import type { ActionIcon } from "../../presentation/assets/game-asset-set.js";
import type {
  GameDisplay,
  GameActionDisplay,
  TileDisplay,
  TileKindDisplay,
} from "./game-display.js";

export interface PendingReactionSubmission {
  readonly receiptAtSubmission: TableReceipt | undefined;
  readonly snapshotAtSubmission: ViewerSafeTableSnapshot;
  readonly windowId: string;
}

export function reactionSubmissionPending(
  pending: PendingReactionSubmission | undefined,
  current: {
    readonly connected: boolean;
    readonly latestReceipt: TableReceipt | undefined;
    readonly snapshot: ViewerSafeTableSnapshot;
    readonly windowId: string | undefined;
  },
): boolean {
  return (
    current.connected &&
    pending?.snapshotAtSubmission === current.snapshot &&
    pending.windowId === current.windowId &&
    (pending.receiptAtSubmission === current.latestReceipt ||
      current.latestReceipt?.outcome === "applied")
  );
}

export function tileLabel(tile: PublicTileView): string {
  const kind = tile.kind;
  if (kind["type"] === "suited") {
    return `${String(kind["rank"])} ${String(kind["suit"])}`;
  }
  if (kind["type"] === "wind") return `${String(kind["wind"])} wind`;
  if (kind["type"] === "dragon") return `${String(kind["dragon"])} dragon`;
  return typeof kind["name"] === "string" ? kind["name"] : "bonus";
}

function reactionLabel(
  action: ReactionAction,
  tiles: readonly TileDisplay[],
): string {
  if (!("handTileIds" in action))
    return action.type === "pass" ? "Pass" : "Declare win";
  return `${action.type === "chow" ? "Chow" : action.type === "pung" ? "Pung" : "Exposed kong"} with ${tiles.map((tile) => tile.label).join(", ")}`;
}

function publicMeldLabel(meld: {
  readonly exposure: "concealed" | "exposed";
  readonly kind: "chow" | "kong" | "pung";
  readonly kongKind?: "added" | "concealed" | "exposed";
}): string {
  if (meld.kind !== "kong") return `${meld.exposure} ${meld.kind}`;
  switch (meld.kongKind) {
    case "added":
      return "added kong";
    case "concealed":
      return "concealed kong";
    case "exposed":
      return "exposed kong";
    case undefined:
      return "kong";
    default:
      return "kong";
  }
}

export interface GameMappingInput {
  readonly connected: boolean;
  readonly latestReceipt: TableReceipt | undefined;
  readonly snapshot: ViewerSafeTableSnapshot;
  readonly pendingReaction?: PendingReactionSubmission | undefined;
  readonly now: number;
}

function mapTile(tile: PublicTileView): TileDisplay {
  // The transport parser validates every kind field and its physical-ID match.
  // Narrow its legacy record type here without duplicating wire validation.
  const kind = tile.kind as unknown as TileKindDisplay;
  return { id: tile.id, label: tileLabel(tile), kind };
}

export function reactionActionId(action: ReactionAction): string {
  return "handTileIds" in action
    ? `${action.type}:${action.handTileIds.join(":")}`
    : action.type;
}

export function mapGameDisplay(input: GameMappingInput): GameDisplay | null {
  const { snapshot, connected, latestReceipt, now, pendingReaction } = input;
  const game = snapshot.view.game;
  if (game === undefined) return null;
  const expired = game.deadlineAt !== null && now >= game.deadlineAt;
  const enabled = connected && !expired;
  const actions = game.viewerActions?.self ?? [];
  const reaction = game.viewerActions?.reaction;
  const pending = reactionSubmissionPending(pendingReaction, {
    connected,
    latestReceipt,
    snapshot,
    windowId: reaction?.windowId,
  });
  const terminal = game.phase === "complete" || game.phase === "exhausted";
  const option = (
    id: string,
    label: string,
    artworkAction: ActionIcon,
    tiles?: readonly TileDisplay[],
  ): GameActionDisplay => ({
    id,
    label,
    disabled: !enabled,
    artworkAction,
    ...(tiles === undefined ? {} : { tiles }),
  });
  // Action IDs select commands, never artwork. Resolve only the projection's
  // public tiles and this viewer's hand; an unresolved ID remains unknown.
  const visibleTiles = new Map<number, TileDisplay>();
  const publicTiles = game.players.flatMap((player) => [
    ...player.bonuses,
    ...player.discards,
    ...player.melds.flatMap((meld) => meld.tileIds),
  ]);
  for (const tile of [
    ...publicTiles,
    ...(game.reaction ? [game.reaction.sourceTile] : []),
    ...(game.viewerHand ?? []),
  ]) {
    visibleTiles.set(tile.id, mapTile(tile));
  }
  const choiceTiles = (ids: readonly number[]): readonly TileDisplay[] =>
    ids.map((id) => visibleTiles.get(id) ?? { id, label: "Unknown tile" });
  const discardIds = new Set(
    actions.flatMap((action) =>
      action.type === "game/discard" ? [action.tileId] : [],
    ),
  );
  const result = game.result;
  const payments =
    result === undefined
      ? []
      : (["east", "south", "west", "north"] as const).map((seat) => ({
          seat,
          amount: result.payments[seat],
        }));
  return {
    heading:
      game.phase === "complete"
        ? "The hand is complete"
        : game.phase === "exhausted"
          ? "The wall is exhausted"
          : game.phase.includes("reactions")
            ? "Waiting for reactions"
            : `${game.turn} to ${game.phase === "awaiting-draw" ? "draw" : "discard"}`,
    wallRemaining: game.wallRemaining,
    deadlineStatus: terminal
      ? null
      : game.deadlineAt === null
        ? "Server deadline is pending."
        : expired
          ? "Deadline passed locally; waiting for the server outcome."
          : `Server deadline ${new Date(game.deadlineAt).toLocaleTimeString()}.`,
    abandoned: snapshot.view.phase === "abandoned",
    rejectionMessage:
      latestReceipt?.outcome === "rejected"
        ? (latestReceipt.error?.message ??
          "The table rejected that game action.")
        : null,
    draw: actions.some((action) => action.type === "game/draw")
      ? option("draw", "Draw tile", "draw")
      : null,
    players: game.players.map((player) => {
      const seat = snapshot.view.seats.find(
        (seat) => seat.seat === player.seat,
      );
      const identity = seat?.occupant
        ? mapPlayerIdentity(seat.occupant)
        : { displayName: player.seat, kind: "human" as const };
      return {
        seat: player.seat,
        ...identity,
        isTurn: !terminal && game.turn === player.seat,
        autopilot: seat?.autopilot ?? false,
        concealedCount: player.concealedCount,
        bonuses: player.bonuses.map(mapTile),
        discards: player.discards.map(mapTile),
        melds: player.melds.map((meld) => ({
          id: meld.id,
          label: publicMeldLabel(meld),
          accessibleLabel: `${player.seat} ${meld.kind} ${meld.id}`,
          sourceSeat: meld.sourceSeat ?? null,
          tiles: meld.tileIds.map(mapTile),
        })),
      };
    }),
    reaction:
      game.reaction === undefined
        ? null
        : {
            heading:
              game.reaction.kind === "discard"
                ? "Discard reaction"
                : "Rob added kong",
            sourceSeat: game.reaction.sourceSeat,
            sourceTile: mapTile(game.reaction.sourceTile),
            status:
              reaction === undefined
                ? "waiting"
                : reaction.status === "submitted" || pending
                  ? "submitted"
                  : "open",
            actions:
              reaction?.actions.map((action) => {
                const tiles =
                  "handTileIds" in action
                    ? choiceTiles(action.handTileIds)
                    : [];
                return option(
                  reactionActionId(action),
                  reactionLabel(action, tiles),
                  action.type,
                  tiles,
                );
              }) ?? [],
          },
    hand:
      game.viewerHand?.map((tile) => ({
        ...mapTile(tile),
        discardDisabled: !enabled || !discardIds.has(tile.id),
      })) ?? null,
    concealedKongs: actions.flatMap((action) =>
      action.type === "game/declare-concealed-kong"
        ? [
            option(
              action.tileIds.join(":"),
              `Concealed kong (${choiceTiles(action.tileIds)
                .map((tile) => tile.label)
                .join(", ")})`,
              "kong",
              choiceTiles(action.tileIds),
            ),
          ]
        : [],
    ),
    addedKongs: actions.flatMap((action) =>
      action.type === "game/propose-added-kong"
        ? [
            option(
              `${action.meldId}:${String(action.tileId)}`,
              `Add ${choiceTiles([action.tileId])
                .map((tile) => tile.label)
                .join(", ")} to kong`,
              "kong",
              choiceTiles([action.tileId]),
            ),
          ]
        : [],
    ),
    win: actions.some((action) => action.type === "game/declare-win")
      ? option("win", "Declare self-drawn win", "win")
      : null,
    result:
      result === undefined
        ? null
        : {
            winnerSeat: result.winnerSeat,
            cappedFaan: result.cappedFaan,
            tablePoints: result.tablePoints,
            source: result.source.type,
            eligibilityFaan: result.eligibilityFaan,
            bonusFaan: result.bonusFaan,
            rawFaan: result.rawFaan,
            awardedPatterns: result.awardedPatterns.map(({ id, faan }) => ({
              id,
              faan,
            })),
            suppressedPatterns: result.suppressedPatterns.map(
              ({ by, pattern, reason }) => ({ by, id: pattern.id, reason }),
            ),
            payments,
            paymentTotal: payments.reduce(
              (sum, payment) => sum + payment.amount,
              0,
            ),
          },
  };
}
