import { BoardSurface } from "../../presentation/board-surface.js";
import { GameIcon } from "../../presentation/game-icon.js";
import { PlayerIcon } from "../../presentation/player-icon.js";
import { Tile } from "../../presentation/tile.js";

import type { GamePanelProps, HandResultDisplay } from "./game-display.js";

function HandResult({ result }: { readonly result: HandResultDisplay | null }) {
  if (result === null) return null;
  return (
    <section className="hand-result" aria-labelledby="hand-result-title">
      <p className="section-kicker">Hand complete</p>
      <h3 id="hand-result-title">{result.winnerSeat} wins</h3>
      <p>
        {result.cappedFaan} faan · {result.tablePoints} table points ·{" "}
        {result.source}
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
          {result.suppressedPatterns.map(({ by, id, reason }) => (
            <li key={`${id}:${by}`}>
              {id} suppressed by {by} ({reason})
            </li>
          ))}
        </ul>
      )}
      <h4>Payments</h4>
      <dl className="payments" aria-label="Exact seat payments">
        {result.payments.map(({ seat, amount }) => (
          <div key={seat}>
            <dt>{seat}</dt>
            <dd>
              {amount >= 0 ? "+" : ""}
              {amount}
            </dd>
          </div>
        ))}
        <div>
          <dt>Total</dt>
          <dd>
            {result.paymentTotal >= 0 ? "+" : ""}
            {result.paymentTotal}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function GamePanel({
  game,
  onDraw,
  onDiscard,
  onReact,
  onConcealedKong,
  onAddedKong,
  onWin,
}: GamePanelProps) {
  if (game === null) return null;
  return (
    <section aria-labelledby="game-title" className="panel game-panel">
      <BoardSurface>
        <div className="panel__heading">
          <div>
            <p className="section-kicker">
              Live hand · wall {game.wallRemaining}
            </p>
            <h2 id="game-title">{game.heading}</h2>
            {game.deadlineStatus !== null ? (
              <p className="deadline-status" role="status">
                {game.deadlineStatus}
              </p>
            ) : null}
          </div>
          {game.draw ? (
            <button
              className="lobby-button draw-button"
              disabled={game.draw.disabled}
              onClick={onDraw}
            >
              <GameIcon kind="action" action="draw" /> {game.draw.label}
            </button>
          ) : null}
        </div>

        {game.abandoned ? (
          <p className="command-error" role="alert">
            This table was abandoned after everyone disconnected.
          </p>
        ) : null}
        {game.rejectionMessage !== null ? (
          <p className="command-error" role="alert">
            {game.rejectionMessage}
          </p>
        ) : null}

        <ol className="game-players" aria-label="Public table state">
          {game.players.map((player) => (
            <li key={player.seat}>
              <div className="player-heading">
                <PlayerIcon
                  displayName={player.displayName}
                  kind={player.kind}
                />
                <GameIcon kind="wind" wind={player.seat} />
                <strong>{player.seat}</strong>
              </div>
              <span>{player.displayName}</span>
              {player.isTurn ? (
                <span>
                  <GameIcon kind="turn" /> Current turn
                </span>
              ) : null}
              {player.autopilot ? (
                <span className="automation-chip">Autopilot</span>
              ) : null}
              <span>
                <span aria-hidden="true">
                  <Tile faceDown size="small" />
                </span>{" "}
                {player.concealedCount} concealed
              </span>
              <span>{player.bonuses.length} bonuses</span>
              <span>{player.discards.length} discards</span>
              {player.melds.map((meld) => (
                <div className="public-meld" key={meld.id}>
                  <span>{meld.label}</span>
                  <ul
                    className="public-tiles"
                    aria-label={meld.accessibleLabel}
                  >
                    {meld.tiles.map((tile) => (
                      <li key={tile.id}>
                        <Tile kind={tile.kind} size="small" />
                      </li>
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
                    <li key={tile.id}>
                      <Tile kind={tile.kind} size="small" />
                    </li>
                  ))}
                </ul>
              ) : null}
              {player.discards.length > 0 ? (
                <ul
                  className="public-tiles"
                  aria-label={`${player.seat} discards`}
                >
                  {player.discards.map((tile) => (
                    <li key={tile.id}>
                      <Tile kind={tile.kind} size="small" />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>

        {game.reaction ? (
          <div className="reaction-window">
            <h3>{game.reaction.heading}</h3>
            <p>
              {game.reaction.sourceSeat} exposed{" "}
              <Tile
                kind={game.reaction.sourceTile.kind}
                size="small"
                highlighted
              />
              .
            </p>
            {game.reaction.status === "submitted" ? (
              <p role="status">Response submitted.</p>
            ) : game.reaction.status === "open" ? (
              <div className="game-actions" aria-label="Available reactions">
                {game.reaction.actions.map((action) => (
                  <button
                    key={action.id}
                    disabled={action.disabled}
                    onClick={() => {
                      onReact(action.id);
                    }}
                  >
                    {action.artworkAction ? (
                      <GameIcon kind="action" action={action.artworkAction} />
                    ) : null}
                    {action.label}
                    {action.tiles && action.tiles.length > 0 ? (
                      <span
                        className="reaction-choice-tiles"
                        aria-hidden="true"
                      >
                        {action.tiles.map((tile) => (
                          <Tile key={tile.id} kind={tile.kind} size="small" />
                        ))}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <p>Waiting for the other players.</p>
            )}
          </div>
        ) : null}

        {game.hand ? (
          <div className="private-hand">
            <h3>Your private hand</h3>
            <ul aria-label="Your concealed tiles">
              {game.hand.map((tile) => (
                <li key={tile.id}>
                  <button
                    aria-label={`Discard ${tile.label}`}
                    disabled={tile.discardDisabled}
                    onClick={() => {
                      onDiscard(tile.id);
                    }}
                  >
                    <Tile kind={tile.kind} />
                    <small>
                      <GameIcon kind="action" action="discard" /> Discard
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            <div className="game-actions" aria-label="Available self actions">
              {game.concealedKongs.map((action) => (
                <button
                  key={action.id}
                  disabled={action.disabled}
                  onClick={() => {
                    onConcealedKong(action.id);
                  }}
                >
                  <GameIcon kind="action" action="kong" /> {action.label}
                </button>
              ))}
              {game.addedKongs.map((action) => (
                <button
                  key={action.id}
                  disabled={action.disabled}
                  onClick={() => {
                    onAddedKong(action.id);
                  }}
                >
                  <GameIcon kind="action" action="kong" /> {action.label}
                </button>
              ))}
              {game.win ? (
                <button
                  disabled={game.win.disabled}
                  onClick={() => {
                    onWin();
                  }}
                >
                  <GameIcon kind="action" action="win" /> {game.win.label}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="privacy-note">
            Spectators receive public tiles and concealed counts only.
          </p>
        )}

        <HandResult result={game.result} />
      </BoardSurface>
    </section>
  );
}
