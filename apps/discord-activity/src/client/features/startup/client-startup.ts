import type { RuntimeConfig } from "../../bootstrap/runtime-config.js";
import type {
  ActivityActor,
  DiscordBridge,
} from "../../adapters/discord/discord-bridge.js";
import type {
  ActivityApi,
  AuthenticatedSession,
  HealthResponse,
} from "../../adapters/transport/activity-api-client.js";
import type {
  SocketStatus,
  SocketStatusMonitor,
  TableReceipt,
  ViewerSafeTableSnapshot,
} from "../../adapters/transport/table-socket-status.js";

export type StartupCheckState =
  "waiting" | "working" | "ready" | "warning" | "failed";

export interface StartupCheck {
  readonly state: StartupCheckState;
  readonly detail: string;
}

export interface ClientStartupStatus {
  readonly complete: boolean;
  readonly activity: StartupCheck;
  readonly health: StartupCheck;
  readonly session: StartupCheck;
  readonly socket: StartupCheck;
  readonly actor?: ActivityActor;
  readonly instanceId?: string;
  readonly healthResponse?: HealthResponse;
  readonly tableSnapshot?: ViewerSafeTableSnapshot | undefined;
  readonly latestReceipt?: TableReceipt | undefined;
  readonly sessionResponse?: AuthenticatedSession;
}

export interface ClientStartupDependencies {
  readonly config: RuntimeConfig;
  readonly bridge: DiscordBridge;
  readonly api: ActivityApi;
  readonly socket: SocketStatusMonitor;
  readonly onStatus: (status: ClientStartupStatus) => void;
}

const waiting = (detail: string): StartupCheck => ({
  state: "waiting",
  detail,
});

export function createInitialStartupStatus(): ClientStartupStatus {
  return {
    complete: false,
    activity: waiting("Waiting to initialize the Activity context."),
    health: waiting("Waiting to contact the Worker."),
    session: waiting("Waiting to establish an application session."),
    socket: waiting("Waiting for an authenticated session."),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unknown startup error occurred.";
}

function socketCheck(status: SocketStatus): StartupCheck {
  switch (status.state) {
    case "authentication-required":
      return {
        state: "failed",
        detail: "Table authorization expired or changed. Authenticate again.",
      };
    case "connected":
      return status.snapshot
        ? {
            state: "ready",
            detail: `Received a viewer-safe lobby snapshot for ${status.snapshot.view.tableId}.`,
          }
        : {
            state: "working",
            detail: "Connected; waiting for the initial table snapshot.",
          };
    case "connecting":
      return {
        state: "working",
        detail: "Connecting to the table coordinator.",
      };
    case "reconnecting":
      return {
        state: "warning",
        detail: `Connection interrupted; reconnecting (attempt ${String(status.attempt)}).`,
      };
    case "session-replaced":
      return {
        state: "failed",
        detail: "This session was replaced. Authenticate again to reconnect.",
      };
    case "protocol-error":
      return {
        state: "failed",
        detail: "The table sent an invalid or unsupported snapshot.",
      };
    case "upgrade-required":
      return {
        state: "failed",
        detail: "This client must be refreshed to use gameplay protocol v2.",
      };
    case "stopped":
      return { state: "warning", detail: "Table connection stopped." };
  }
}

export function startClientStartup({
  config,
  bridge,
  api,
  socket,
  onStatus,
}: ClientStartupDependencies): () => void {
  const abortController = new AbortController();
  let stopSocket: (() => void) | undefined;
  let status = createInitialStartupStatus();

  const publish = (patch: Partial<ClientStartupStatus>): void => {
    status = { ...status, ...patch };
    onStatus(status);
  };

  const run = async (): Promise<void> => {
    publish({
      activity: { state: "working", detail: "Initializing Activity context." },
      health: { state: "working", detail: "Checking Worker health." },
    });

    try {
      const context = await bridge.initialize();
      publish({
        instanceId: context.instanceId,
        activity: {
          state: "ready",
          detail:
            config.mode === "discord"
              ? "Discord Embedded App SDK is ready."
              : "Standalone mock Activity is ready.",
        },
      });

      const health = await api.getHealth(abortController.signal);
      if (health.mode !== config.mode) {
        throw new Error(
          `Worker is in ${health.mode} mode while the client is in ${config.mode} mode.`,
        );
      }
      publish({
        healthResponse: health,
        health: { state: "ready", detail: "Worker API is healthy." },
        session: {
          state: "working",
          detail: "Establishing application session.",
        },
      });

      let expectedActor: ActivityActor;
      if (config.mode === "mock") {
        const authenticated = await api.createMockSession(
          config.mockActor.displayName,
          abortController.signal,
        );
        expectedActor = authenticated.actor;
      } else {
        const authorization = await bridge.authorize();
        if (!authorization) {
          throw new Error(
            "Discord bridge did not provide an authorization code.",
          );
        }

        const exchanged = await api.exchangeDiscordCode(
          authorization,
          context,
          abortController.signal,
        );
        const sdkActor = await bridge.authenticate(exchanged.accessToken);
        if (sdkActor.id !== exchanged.actor.id) {
          throw new Error(
            "Discord SDK identity does not match the server session.",
          );
        }
        expectedActor = exchanged.actor;
      }

      const session = await api.getSession(abortController.signal);
      if (!session.authenticated) {
        throw new Error("The application session was not established.");
      }
      if (
        session.mode !== config.mode ||
        session.actor.id !== expectedActor.id
      ) {
        throw new Error(
          "Application session does not match the authenticated actor.",
        );
      }

      publish({
        actor: session.actor,
        sessionResponse: session,
        session: {
          state: "ready",
          detail: `Signed in as ${session.actor.displayName}.`,
        },
      });

      if (session.access === "join-required") {
        publish({
          complete: false,
          socket: {
            state: "waiting",
            detail:
              "Waiting for an actor-bound table invitation before connecting.",
          },
        });
        return;
      }

      stopSocket = socket.start((socketStatus) => {
        const terminalSession =
          socketStatus.state === "session-replaced" ||
          socketStatus.state === "authentication-required" ||
          socketStatus.state === "upgrade-required";
        publish({
          complete:
            socketStatus.state === "connected" &&
            socketStatus.snapshot !== undefined,
          ...(terminalSession
            ? { tableSnapshot: undefined, latestReceipt: undefined }
            : socketStatus.snapshot
              ? {
                  tableSnapshot: socketStatus.snapshot,
                  latestReceipt: socketStatus.latestReceipt,
                }
              : {}),
          ...(terminalSession
            ? {
                session: {
                  state: "failed" as const,
                  detail:
                    socketStatus.state === "session-replaced"
                      ? "This session was replaced. Authenticate again."
                      : socketStatus.state === "upgrade-required"
                        ? "This client must be refreshed for gameplay protocol v2."
                        : "Table authorization expired or changed. Authenticate again.",
                },
              }
            : {}),
          socket: socketCheck(socketStatus),
        });
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }

      const detail = errorMessage(error);
      publish({
        complete: false,
        session:
          status.session.state === "ready"
            ? status.session
            : { state: "failed", detail },
        health:
          status.health.state === "working"
            ? { state: "failed", detail }
            : status.health,
        activity:
          status.activity.state === "working"
            ? { state: "failed", detail }
            : status.activity,
        socket: {
          state: "failed",
          detail: "Startup did not reach the table socket.",
        },
      });
    }
  };

  onStatus(status);
  void run();

  return () => {
    abortController.abort();
    stopSocket?.();
  };
}
