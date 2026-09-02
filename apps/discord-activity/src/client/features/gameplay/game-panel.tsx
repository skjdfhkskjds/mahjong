import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import type {
  PublicTileView,
  ReactionAction,
  TableCommand,
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";

export interface GamePanelProps {
  readonly connected: boolean;
  readonly latestReceipt: TableReceipt | undefined;
  readonly onCommand: (command: TableCommand) => boolean;
  readonly snapshot: ViewerSafeTableSnapshot;
}

export interface PendingReactionSubmission {
  readonly receiptAtSubmission: TableReceipt | undefined;
  readonly snapshotAtSubmission: ViewerSafeTableSnapshot;
  readonly windowId: string;
}

export interface TableCommandButtonProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly command: TableCommand;
  readonly disabled: boolean;
  readonly onCommand: (command: TableCommand) => boolean;
  readonly onSent?: () => void;
}

export function TableCommandButton({
  children,
  className,
  command,
  disabled,
  onCommand,
  onSent,
}: TableCommandButtonProps): ReactElement<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "button"
> {
  return (
    <button
      className={className}
      disabled={disabled}
      onClick={() => {
        if (onCommand(command)) onSent?.();
      }}
    >
      {children}
    </button>
  );
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

function useDeadlineExpired(deadlineAt: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadlineAt === null) return;
    const delay = Math.max(0, Math.min(deadlineAt - Date.now(), 1_000));
    const timer = window.setTimeout(() => {
      setNow(Date.now());
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [deadlineAt, now]);
  return deadlineAt !== null && now >= deadlineAt;
}

function reactionLabel(action: ReactionAction): string {
  if (!("handTileIds" in action))
    return action.type === "pass" ? "Pass" : "Declare win";
  const ids = action.handTileIds.map(String).join(", ");
  return `${action.type === "chow" ? "Chow" : action.type === "pung" ? "Pung" : "Exposed kong"} with tiles ${ids}`;
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

function HandResult({
  snapshot,
}: {
  readonly snapshot: ViewerSafeTableSnapshot;
}) {
  const result = snapshot.view.game?.result;
  if (result === undefined) return null;
  const paymentTotal =
    result.payments.east +
    result.payments.south +
    result.payments.west +
    result.payments.north;
  return (
    <section className="hand-result" aria-labelledby="hand-result-title">
      <p className="section-kicker">Hand complete</p>
      <h3 id="hand-result-title">{result.winnerSeat} wins</h3>
      <p>
        {result.cappedFaan} faan · {result.tablePoints} table points ·{" "}
        {result.source.type}
      </p>
      <dl className="score-summary">
        <div>
          <dt>Eligibility</dt>
          <dd>{result.eligibilityFaan} faan</dd>
        </div>
        <div>
          <dt>Bonus</dt>
          <dd>{result.bonusFaan} faan</dd>
        </div>
        <div>
          <dt>Raw / capped</dt>
          <dd>
            {result.rawFaan} / {result.cappedFaan}
          </dd>
        </div>
      </dl>
      <h4>Awarded patterns</h4>
      <ul aria-label="Awarded scoring patterns">
        {result.awardedPatterns.map((pattern) => (
          <li key={pattern.id}>
            {pattern.id} (+{pattern.faan} faan)
          </li>
        ))}
      </ul>
      <h4>Suppressed patterns</h4>
      {result.suppressedPatterns.length === 0 ? (
        <p>None</p>
      ) : (
        <ul aria-label="Suppressed scoring patterns">
          {result.suppressedPatterns.map(({ by, pattern, reason }) => (
            <li key={`${pattern.id}:${by}`}>
              {pattern.id} suppressed by {by} ({reason})
            </li>
          ))}
        </ul>
      )}
      <h4>Payments</h4>
      <dl className="payments" aria-label="Exact seat payments">
        {(["east", "south", "west", "north"] as const).map((seat) => (
          <div key={seat}>
            <dt>{seat}</dt>
            <dd>
              {result.payments[seat] >= 0 ? "+" : ""}
              {result.payments[seat]}
            </dd>
          </div>
        ))}
        <div>
          <dt>Total</dt>
          <dd>
            {paymentTotal >= 0 ? "+" : ""}
            {paymentTotal}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function GamePanel({
  connected,
  latestReceipt,
  onCommand,
  snapshot,
}: GamePanelProps) {
  const game = snapshot.view.game;
  const [pendingReaction, setPendingReaction] =
    useState<PendingReactionSubmission>();
  const deadlineExpired = useDeadlineExpired(game?.deadlineAt ?? null);
  if (game === undefined) return null;
  const enabled = connected && !deadlineExpired;
  const selfActions = game.viewerActions?.self ?? [];
  const reaction = game.viewerActions?.reaction;
  const reactionPending = reactionSubmissionPending(pendingReaction, {
    connected,
    latestReceipt,
    snapshot,
    windowId: reaction?.windowId,
  });
  const rejected = latestReceipt?.outcome === "rejected" ? latestReceipt : null;
  const canDraw = selfActions.some(({ type }) => type === "game/draw");
  const canWin = selfActions.some(({ type }) => type === "game/declare-win");
  const discardIds = new Set(
    selfActions.flatMap((action) =>
      action.type === "game/discard" ? [action.tileId] : [],
    ),
  );
  const concealedKongs = selfActions.filter(
    (action) => action.type === "game/declare-concealed-kong",
  );
  const addedKongs = selfActions.filter(
    (action) => action.type === "game/propose-added-kong",
  );
  const terminal = game.phase === "complete" || game.phase === "exhausted";
  const heading =
    game.phase === "complete"
      ? "The hand is complete"
      : game.phase === "exhausted"
        ? "The wall is exhausted"
        : game.phase.includes("reactions")
          ? "Waiting for reactions"
          : `${game.turn} to ${game.phase === "awaiting-draw" ? "draw" : "discard"}`;

  return (
    <section aria-labelledby="game-title" className="panel game-panel">
      <div className="panel__heading">
        <div>
          <p className="section-kicker">
            Live hand · wall {game.wallRemaining}
          </p>
          <h2 id="game-title">{heading}</h2>
          {!terminal ? (
            <p className="deadline-status" role="status">
              {game.deadlineAt === null
                ? "Server deadline is pending."
                : deadlineExpired
                  ? "Deadline passed locally; waiting for the server outcome."
                  : `Server deadline ${new Date(game.deadlineAt).toLocaleTimeString()}.`}
            </p>
          ) : null}
        </div>
        {canDraw ? (
          <TableCommandButton
            className="lobby-button draw-button"
            command={{ type: "game/draw" }}
            disabled={!enabled}
            onCommand={onCommand}
          >
            Draw tile
          </TableCommandButton>
        ) : null}
      </div>

      {snapshot.view.phase === "abandoned" ? (
        <p className="command-error" role="alert">
          This table was abandoned after everyone disconnected.
        </p>
      ) : null}
      {rejected ? (
        <p className="command-error" role="alert">
          {rejected.error?.message ?? "The table rejected that game action."}
        </p>
      ) : null}

      <ol className="game-players" aria-label="Public table state">
        {game.players.map((player) => {
          const seat = snapshot.view.seats.find(
            ({ seat }) => seat === player.seat,
          );
          return (
            <li key={player.seat}>
              <strong>{player.seat}</strong>
              {seat?.autopilot ? (
                <span className="automation-chip">Autopilot</span>
              ) : null}
              <span>{player.concealedCount} concealed</span>
              <span>{player.bonuses.length} bonuses</span>
              <span>{player.discards.length} discards</span>
              {player.melds.map((meld) => (
                <div className="public-meld" key={meld.id}>
                  <span>{publicMeldLabel(meld)}</span>
                  <ul
                    className="public-tiles"
                    aria-label={`${player.seat} ${meld.kind} ${meld.id}`}
                  >
                    {meld.tileIds.map((tile) => (
                      <li key={tile.id}>{tileLabel(tile)}</li>
                    ))}
                  </ul>
                  {meld.sourceSeat ? (
                    <small>from {meld.sourceSeat}</small>
                  ) : null}
                </div>
              ))}
              {player.bonuses.length > 0 ? (
                <ul
                  className="public-tiles"
                  aria-label={`${player.seat} exposed bonuses`}
                >
                  {player.bonuses.map((tile) => (
                    <li key={tile.id}>{tileLabel(tile)}</li>
                  ))}
                </ul>
              ) : null}
              {player.discards.length > 0 ? (
                <ul
                  className="public-tiles"
                  aria-label={`${player.seat} discards`}
                >
                  {player.discards.map((tile) => (
                    <li key={tile.id}>{tileLabel(tile)}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>

      {game.reaction ? (
        <div className="reaction-window">
          <h3>
            {game.reaction.kind === "discard"
              ? "Discard reaction"
              : "Rob added kong"}
          </h3>
          <p>
            {game.reaction.sourceSeat} exposed{" "}
            {tileLabel(game.reaction.sourceTile)}.
          </p>
          {reaction ? (
            reaction.status === "submitted" || reactionPending ? (
              <p role="status">Response submitted.</p>
            ) : (
              <div className="game-actions" aria-label="Available reactions">
                {reaction.actions.map((action) => (
                  <TableCommandButton
                    key={JSON.stringify(action)}
                    command={{
                      type: "game/react",
                      windowId: reaction.windowId,
                      response: action,
                    }}
                    disabled={!enabled}
                    onCommand={onCommand}
                    onSent={() => {
                      setPendingReaction({
                        receiptAtSubmission: latestReceipt,
                        snapshotAtSubmission: snapshot,
                        windowId: reaction.windowId,
                      });
                    }}
                  >
                    {reactionLabel(action)}
                  </TableCommandButton>
                ))}
              </div>
            )
          ) : (
            <p>Waiting for the other players.</p>
          )}
        </div>
      ) : null}

      {game.viewerHand ? (
        <div className="private-hand">
          <h3>Your private hand</h3>
          <ul aria-label="Your concealed tiles">
            {game.viewerHand.map((tile) => (
              <li key={tile.id}>
                <button
                  aria-label={`Discard ${tileLabel(tile)}`}
                  disabled={!enabled || !discardIds.has(tile.id)}
                  onClick={() => {
                    onCommand({ type: "game/discard", tileId: tile.id });
                  }}
                >
                  <span>{tileLabel(tile)}</span>
                  <small>#{tile.id}</small>
                </button>
              </li>
            ))}
          </ul>
          <div className="game-actions" aria-label="Available self actions">
            {concealedKongs.map((action) => (
              <button
                key={action.tileIds.join(":")}
                disabled={!enabled}
                onClick={() => {
                  onCommand(action);
                }}
              >
                Concealed kong ({action.tileIds.join(", ")})
              </button>
            ))}
            {addedKongs.map((action) => (
              <button
                key={`${action.meldId}:${String(action.tileId)}`}
                disabled={!enabled}
                onClick={() => {
                  onCommand(action);
                }}
              >
                Add tile #{action.tileId} to kong
              </button>
            ))}
            {canWin ? (
              <button
                disabled={!enabled}
                onClick={() => {
                  onCommand({ type: "game/declare-win" });
                }}
              >
                Declare self-drawn win
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="privacy-note">
          Spectators receive public tiles and concealed counts only.
        </p>
      )}

      <HandResult snapshot={snapshot} />
    </section>
  );
}
