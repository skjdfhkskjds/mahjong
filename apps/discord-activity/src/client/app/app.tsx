import { useEffect, useMemo, useState } from "react";

import { createDiscordBridge } from "../adapters/discord/create-discord-bridge.js";
import { HttpActivityApi } from "../adapters/transport/activity-api-client.js";
import {
  createTableSocketUrl,
  ReconnectingSocketStatusMonitor,
  TABLE_PROTOCOL_VERSION,
  type TableCommandEnvelope,
} from "../adapters/transport/table-socket-status.js";
import type { RuntimeConfig } from "../bootstrap/runtime-config.js";
import {
  createInitialStartupStatus,
  startClientStartup,
  type ClientStartupStatus,
  type StartupCheck,
} from "../features/startup/client-startup.js";
import { GameController } from "../features/gameplay/game-controller.js";
import { LobbyController } from "../features/lobby/lobby-controller.js";

interface AppProps {
  readonly config: RuntimeConfig;
}

const checkLabels = {
  activity: "Activity context",
  health: "Worker API",
  session: "Application session",
  socket: "Table connection",
} as const;

type CheckName = keyof typeof checkLabels;

function StatusCard({ name, check }: { name: CheckName; check: StartupCheck }) {
  return (
    <li className="status-card">
      <div className="status-card__heading">
        <span
          className={`status-dot status-dot--${check.state}`}
          aria-hidden="true"
        />
        <h2>{checkLabels[name]}</h2>
        <span className="status-word">{check.state}</span>
      </div>
      <p>{check.detail}</p>
    </li>
  );
}

function formatExpiry(value: string | undefined): string {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(date);
}

export function App({ config }: AppProps) {
  const [attempt, setAttempt] = useState(0);
  const [commandFailure, setCommandFailure] = useState<string>();
  const [status, setStatus] = useState<ClientStartupStatus>(
    createInitialStartupStatus,
  );
  const dependencies = useMemo(() => {
    const bridge = createDiscordBridge(config);
    const api = new HttpActivityApi(config.apiBaseUrl);
    const socketUrl = createTableSocketUrl(config.apiBaseUrl, window.location);
    const socket = new ReconnectingSocketStatusMonitor(socketUrl);
    return { bridge, api, socket };
  }, [config]);

  useEffect(() => {
    setStatus(createInitialStartupStatus());
    return startClientStartup({
      config,
      ...dependencies,
      onStatus: setStatus,
    });
  }, [attempt, config, dependencies]);

  const hasFailure = [
    status.activity,
    status.health,
    status.session,
    status.socket,
  ].some((check) => check.state === "failed");
  const snapshot = status.tableSnapshot;
  const lobbyConnected = status.complete && snapshot !== undefined;

  const sendTableCommand = (
    command: TableCommandEnvelope["command"],
  ): boolean => {
    if (!lobbyConnected) {
      return false;
    }
    try {
      dependencies.socket.sendCommand({
        type: "table/command",
        protocolVersion: TABLE_PROTOCOL_VERSION,
        commandId: crypto.randomUUID(),
        expectedStateVersion: snapshot.stateVersion,
        command,
      });
      setCommandFailure(undefined);
      return true;
    } catch (error) {
      setCommandFailure(
        error instanceof Error ? error.message : "Unable to send table action.",
      );
      return false;
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Hong Kong Mahjong · private alpha</p>
          <h1>Your table is taking shape.</h1>
          <p className="hero__copy">
            Pick a wind, gather four players, and ready up. Your lobby survives
            reconnects while the table keeps every viewer projection private.
          </p>
        </div>
        <div className="mode-chip" aria-label={`Runtime mode: ${config.mode}`}>
          <span aria-hidden="true">{config.mode === "mock" ? "◇" : "◆"}</span>
          {config.mode} mode
        </div>
      </header>

      <main>
        {snapshot?.view.phase === "abandoned" &&
        snapshot.view.game === undefined ? (
          <section
            className="panel lobby-panel"
            aria-labelledby="abandoned-title"
          >
            <p className="section-kicker">Table closed</p>
            <h2 id="abandoned-title">
              This table was abandoned after everyone disconnected.
            </h2>
          </section>
        ) : snapshot?.view.phase === "lobby" ? (
          <LobbyController
            canManageBots={
              status.sessionResponse?.access === "member" &&
              status.sessionResponse.role === "owner"
            }
            connected={lobbyConnected}
            latestReceipt={status.latestReceipt}
            onCommand={sendTableCommand}
            snapshot={snapshot}
          />
        ) : snapshot ? (
          <GameController
            connected={lobbyConnected}
            latestReceipt={status.latestReceipt}
            onCommand={sendTableCommand}
            snapshot={snapshot}
          />
        ) : (
          <LobbyController
            canManageBots={
              status.sessionResponse?.access === "member" &&
              status.sessionResponse.role === "owner"
            }
            connected={lobbyConnected}
            latestReceipt={status.latestReceipt}
            onCommand={sendTableCommand}
            snapshot={snapshot}
          />
        )}
        {commandFailure ? (
          <p className="command-error command-error--page" role="alert">
            {commandFailure}
          </p>
        ) : null}
        <section aria-labelledby="startup-title" className="panel">
          <div className="panel__heading">
            <div>
              <p className="section-kicker">Connection check</p>
              <h2 id="startup-title">
                {status.complete
                  ? "Lobby connection ready"
                  : hasFailure
                    ? "Startup needs attention"
                    : "Preparing your table"}
              </h2>
            </div>
            <div
              className={`overall-mark ${status.complete ? "overall-mark--ready" : ""}`}
              aria-hidden="true"
            >
              {status.complete ? "✓" : "東"}
            </div>
          </div>

          <ul className="status-grid" aria-live="polite">
            {(Object.keys(checkLabels) as CheckName[]).map((name) => (
              <StatusCard key={name} name={name} check={status[name]} />
            ))}
          </ul>

          {hasFailure ? (
            <button
              className="retry-button"
              onClick={() => {
                setAttempt((value) => value + 1);
              }}
            >
              Try startup again
            </button>
          ) : null}
        </section>

        <aside
          className="panel diagnostics"
          aria-labelledby="diagnostics-title"
        >
          <div>
            <p className="section-kicker">Diagnostics</p>
            <h2 id="diagnostics-title">Session details</h2>
          </div>
          <dl>
            <div>
              <dt>Player</dt>
              <dd>{status.actor?.displayName ?? "Waiting…"}</dd>
            </div>
            <div>
              <dt>Activity instance</dt>
              <dd className="technical-value">
                {status.instanceId ?? "Waiting…"}
              </dd>
            </div>
            <div>
              <dt>Session expires</dt>
              <dd>{formatExpiry(status.sessionResponse?.expiresAt)}</dd>
            </div>
            <div>
              <dt>Worker clock</dt>
              <dd className="technical-value">
                {status.healthResponse?.now ?? "Waiting…"}
              </dd>
            </div>
            <div>
              <dt>Table</dt>
              <dd className="technical-value">
                {status.tableSnapshot?.view.tableId ?? "Waiting…"}
              </dd>
            </div>
            <div>
              <dt>Viewer snapshot</dt>
              <dd>
                {status.tableSnapshot
                  ? `${status.tableSnapshot.view.viewer.role}, state ${String(status.tableSnapshot.stateVersion)}`
                  : "Waiting…"}
              </dd>
            </div>
          </dl>
          <p className="privacy-note">
            Discord access tokens stay in memory only long enough to
            authenticate the Embedded App SDK. This screen uses the separate
            application session.
          </p>
        </aside>
      </main>

      <footer>
        <span aria-hidden="true">🀄</span> Seats, spectators, and ready state
        persist with this table.
      </footer>
    </div>
  );
}
