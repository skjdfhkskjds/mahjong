export type SocketConnectionState =
  "connecting" | "connected" | "protocol-error" | "reconnecting" | "stopped";

export interface ViewerSafeTableSnapshot {
  readonly type: "table/snapshot";
  readonly protocolVersion: number;
  readonly stateVersion: number;
  readonly view: {
    readonly phase: "lobby";
    readonly tableId: string;
    readonly viewer: {
      readonly role: "player" | "spectator";
      readonly actor: {
        readonly id: string;
        readonly displayName: string;
      };
    };
  };
}

export interface SocketStatus {
  readonly state: SocketConnectionState;
  readonly attempt: number;
  readonly snapshot?: ViewerSafeTableSnapshot;
}

export interface SocketStatusMonitor {
  start(onStatus: (status: SocketStatus) => void): () => void;
}

type BrowserLocation = Pick<Location, "origin">;
type SocketFactory = (url: string) => WebSocket;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseTableSnapshot(value: unknown): ViewerSafeTableSnapshot {
  if (!isRecord(value) || value["type"] !== "table/snapshot") {
    throw new Error("Table socket message is not a snapshot.");
  }
  const view = value["view"];
  if (!isRecord(view) || view["phase"] !== "lobby") {
    throw new Error("Table snapshot has an invalid view.");
  }
  const viewer = view["viewer"];
  if (!isRecord(viewer)) {
    throw new Error("Table snapshot is missing its viewer.");
  }
  const actor = viewer["actor"];
  if (!isRecord(actor)) {
    throw new Error("Table snapshot is missing its viewer actor.");
  }
  const role = viewer["role"];
  if (role !== "player" && role !== "spectator") {
    throw new Error("Table snapshot has an invalid viewer role.");
  }
  if (
    value["protocolVersion"] !== 1 ||
    !nonNegativeInteger(value["stateVersion"]) ||
    !nonEmptyString(view["tableId"]) ||
    !nonEmptyString(actor["id"]) ||
    !nonEmptyString(actor["displayName"])
  ) {
    throw new Error("Table snapshot has invalid version or identity fields.");
  }

  return {
    type: "table/snapshot",
    protocolVersion: value["protocolVersion"],
    stateVersion: value["stateVersion"],
    view: {
      phase: "lobby",
      tableId: view["tableId"],
      viewer: {
        role,
        actor: {
          id: actor["id"],
          displayName: actor["displayName"],
        },
      },
    },
  };
}

function parseSocketMessage(
  event: MessageEvent<unknown>,
): ViewerSafeTableSnapshot {
  if (typeof event.data !== "string") {
    throw new Error("Table socket messages must be JSON text.");
  }

  try {
    return parseTableSnapshot(JSON.parse(event.data) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Table socket message is not valid JSON.", {
        cause: error,
      });
    }
    throw error;
  }
}

export function createTableSocketUrl(
  apiBaseUrl: string,
  location: BrowserLocation,
): string {
  const base = apiBaseUrl === "" ? location.origin : apiBaseUrl;
  const url = new URL("/api/table/socket", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class ReconnectingSocketStatusMonitor implements SocketStatusMonitor {
  private readonly url: string;
  private readonly createSocket: SocketFactory;

  public constructor(
    url: string,
    createSocket: SocketFactory = (value) => new WebSocket(value),
  ) {
    this.url = url;
    this.createSocket = createSocket;
  }

  public start(onStatus: (status: SocketStatus) => void): () => void {
    let attempt = 0;
    let stopped = false;
    let hasConnected = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;
    let lastSnapshot: ViewerSafeTableSnapshot | undefined;

    const publish = (
      state: SocketConnectionState,
      currentAttempt: number,
    ): void => {
      onStatus({
        state,
        attempt: currentAttempt,
        ...(lastSnapshot ? { snapshot: lastSnapshot } : {}),
      });
    };

    const connect = (): void => {
      attempt += 1;
      publish(hasConnected ? "reconnecting" : "connecting", attempt);
      socket = this.createSocket(this.url);

      socket.addEventListener("open", () => {
        hasConnected = true;
        attempt = 0;
        publish("connected", 0);
        if (lastSnapshot) {
          socket?.send(
            JSON.stringify({
              type: "table/resync",
              lastSeenStateVersion: lastSnapshot.stateVersion,
            }),
          );
        }
      });
      socket.addEventListener("message", (event) => {
        try {
          lastSnapshot = parseSocketMessage(event);
          publish("connected", 0);
        } catch {
          stopped = true;
          socket?.close(1002, "Unsupported table protocol");
          publish("protocol-error", attempt);
        }
      });
      socket.addEventListener("close", () => {
        if (stopped) {
          return;
        }

        const retryAttempt = Math.max(1, attempt);
        const delay = Math.min(1_000 * 2 ** (retryAttempt - 1), 15_000);
        retryTimer = window.setTimeout(connect, delay);
        publish("reconnecting", retryAttempt);
      });
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      socket?.close(1000, "Client stopped");
      publish("stopped", 0);
    };
  }
}
