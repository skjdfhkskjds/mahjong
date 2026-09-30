import { assertNever } from "../../adapters/transport/table-socket-lifecycle.js";
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
      return {
        state: "ready",
        detail: "Received a fresh viewer-safe table snapshot.",
      };
    case "awaiting-snapshot":
      return {
        state: "working",
        detail: "Connected; waiting for a fresh table snapshot.",
      };
    case "disconnecting":
      return {
        state: "warning",
        detail: "Table connection interrupted.",
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
        detail: "This client must be refreshed to use gameplay protocol v1.",
      };
    case "stopped":
      return { state: "warning", detail: "Table connection stopped." };
    default:
      return assertNever(status);
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
  const isAborted = (): boolean => abortController.signal.aborted;
  let stopSocket: (() => void) | undefined;
  const unsubscribeMessages: (() => void)[] = [];
  let status = createInitialStartupStatus();

  const publish = (patch: Partial<ClientStartupStatus>): void => {
    if (isAborted()) {
      return;
    }
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
      if (isAborted()) {
        return;
      }
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

      if (isAborted()) {
        return;
      }
      const health = await api.getHealth(abortController.signal);
      if (isAborted()) {
        return;
      }
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

      if (isAborted()) {
        return;
      }
      let expectedActor: ActivityActor;
      if (config.mode === "mock") {
        const authenticated = await api.createMockSession(
          config.mockActor.displayName,
          abortController.signal,
        );
        if (isAborted()) {
          return;
        }
        expectedActor = authenticated.actor;
      } else {
        const authorization = await bridge.authorize();
        if (isAborted()) {
          return;
        }
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
        if (isAborted()) {
          return;
        }
        const sdkActor = await bridge.authenticate(exchanged.accessToken);
        if (isAborted()) {
          return;
        }
        if (sdkActor.id !== exchanged.actor.id) {
          throw new Error(
            "Discord SDK identity does not match the server session.",
          );
        }
        expectedActor = exchanged.actor;
      }

      const session = await api.getSession(abortController.signal);
      if (isAborted()) {
        return;
      }
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

      if (isAborted()) {
        return;
      }
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

      // Subscribe before starting: the transport may synchronously deliver its
      // initial snapshot, then announce that commands are usable.
      unsubscribeMessages.push(
        socket.subscribe("table/snapshot", (snapshot) => {
          publish({ tableSnapshot: snapshot });
        }),
        socket.subscribe("table/receipt", (receipt) => {
          publish({ latestReceipt: receipt });
        }),
      );
      stopSocket = socket.start((socketStatus) => {
        const terminalSession =
          socketStatus.state === "session-replaced" ||
          socketStatus.state === "authentication-required" ||
          socketStatus.state === "upgrade-required";
        publish({
          complete:
            socketStatus.state === "connected" &&
            status.tableSnapshot !== undefined,
          ...(socketStatus.state !== "connected"
            ? { tableSnapshot: undefined, latestReceipt: undefined }
            : {}),
          ...(terminalSession
            ? {
                session: {
                  state: "failed" as const,
                  detail:
                    socketStatus.state === "session-replaced"
                      ? "This session was replaced. Authenticate again."
                      : socketStatus.state === "upgrade-required"
                        ? "This client must be refreshed for gameplay protocol v1."
                        : "Table authorization expired or changed. Authenticate again.",
                },
              }
            : {}),
          socket: socketCheck(socketStatus),
        });
      });
      // A status subscriber may dispose startup during synchronous start.
      if (isAborted()) {
        stopSocket();
      }
    } catch (error) {
      if (isAborted()) {
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
    for (const unsubscribe of unsubscribeMessages) {
      unsubscribe();
    }
    stopSocket?.();
  };
}
