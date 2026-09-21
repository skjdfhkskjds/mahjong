import type { LobbyPanelProps, LobbySeatDisplay } from "./lobby-display.js";

export function LobbySeat({ seat }: { readonly seat: LobbySeatDisplay }) {
  return (
    <li className="seat-card">
      <div className="seat-card__heading">
        <h3>{seat.seat}</h3>
        <span className={`ready-chip ${seat.ready ? "ready-chip--ready" : ""}`}>
          {seat.status}
        </span>
      </div>
      <p>{seat.displayName}</p>
      {seat.onClaimSeat ? (
        <button
          className="lobby-button"
          disabled={seat.disabled}
          onClick={seat.onClaimSeat}
        >
          {seat.claimLabel}
        </button>
      ) : null}
      {seat.onAddBot ? (
        <button
          className="lobby-button"
          disabled={seat.botControlsDisabled}
          onClick={seat.onAddBot}
        >
          Add bot
        </button>
      ) : null}
      {seat.onRemoveBot ? (
        <button
          className="lobby-button lobby-button--quiet"
          disabled={seat.botControlsDisabled}
          onClick={seat.onRemoveBot}
        >
          Remove bot
        </button>
      ) : null}
      {seat.onToggleReady || seat.onLeaveSeat ? (
        <div className="seat-actions">
          {seat.onToggleReady ? (
            <button
              className="lobby-button"
              disabled={seat.disabled}
              onClick={seat.onToggleReady}
            >
              {seat.readinessLabel}
            </button>
          ) : null}
          {seat.onLeaveSeat ? (
            <button
              className="lobby-button lobby-button--quiet"
              disabled={seat.disabled}
              onClick={seat.onLeaveSeat}
            >
              Leave {seat.seat} seat
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function LobbyPanel({
  connectionStatus,
  error,
  botHelp,
  seats,
  spectators,
  startDisabled,
  onStartHand,
}: LobbyPanelProps) {
  return (
    <section aria-labelledby="lobby-title" className="panel lobby-panel">
      <div className="panel__heading lobby-heading">
        <div>
          <p className="section-kicker">Persistent lobby</p>
          <h2 id="lobby-title">Choose a seat and get ready</h2>
        </div>
        <p className="lobby-connection" role="status">
          {connectionStatus}
        </p>
      </div>
      {botHelp ? <p>{botHelp}</p> : null}
      {seats ? (
        <>
          {error ? (
            <p className="command-error" role="alert">
              {error}
            </p>
          ) : null}
          <ul className="seat-grid" aria-label="Table seats">
            {seats.map((seat) => (
              <LobbySeat key={seat.seat} seat={seat} />
            ))}
          </ul>
          {onStartHand ? (
            <button
              className="lobby-button game-start-button"
              disabled={startDisabled}
              onClick={onStartHand}
            >
              Start hand
            </button>
          ) : null}
          <div className="spectator-list">
            <h3>Spectators ({spectators.length})</h3>
            {spectators.length > 0 ? (
              <ul>
                {spectators.map((spectator) => (
                  <li key={spectator.id}>{spectator.displayName}</li>
                ))}
              </ul>
            ) : (
              <p>No spectators</p>
            )}
          </div>
        </>
      ) : (
        <p className="lobby-placeholder" role="status">
          The lobby will appear after the table sends a viewer-safe snapshot.
        </p>
      )}
    </section>
  );
}
