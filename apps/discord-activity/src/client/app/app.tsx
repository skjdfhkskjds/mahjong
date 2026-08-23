import { useEffect, useMemo, useState } from "react";

import { createDiscordBridge } from "../adapters/discord/create-discord-bridge.js";
import { HttpActivityApi } from "../adapters/transport/activity-api-client.js";
import {
  createTableSocketUrl,
  ReconnectingSocketStatusMonitor,
} from "../adapters/transport/table-socket-status.js";
import type { RuntimeConfig } from "../bootstrap/runtime-config.js";
import {
  createInitialStartupStatus,
  startClientStartup,
  type ClientStartupStatus,
  type StartupCheck,
} from "../features/startup/client-startup.js";

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

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Hong Kong Mahjong · private alpha</p>
          <h1>Your table is taking shape.</h1>
          <p className="hero__copy">
            This walking skeleton verifies the Activity, Worker, session, and
            real-time connection before gameplay is added.
          </p>
        </div>
        <div className="mode-chip" aria-label={`Runtime mode: ${config.mode}`}>
          <span aria-hidden="true">{config.mode === "mock" ? "◇" : "◆"}</span>
          {config.mode} mode
        </div>
      </header>

      <main>
        <section aria-labelledby="startup-title" className="panel">
          <div className="panel__heading">
            <div>
              <p className="section-kicker">Connection check</p>
              <h2 id="startup-title">
                {status.complete
                  ? "Ready for the next milestone"
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
              <dt>Mock table</dt>
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
        <span aria-hidden="true">🀄</span> No game state is created by this
        shell.
      </footer>
    </div>
  );
}
