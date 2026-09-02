import {
  parseSocketMessage,
  TABLE_PROTOCOL_VERSION,
  validateCommand,
  type TableCommandEnvelope,
  type TableReceipt,
  type TableSocketMessage,
  type ViewerSafeTableSnapshot,
} from "./table-socket-protocol-v2.js";

export {
  parseTableReceipt,
  parseTableSnapshot,
  TABLE_PROTOCOL_VERSION,
  type GameView,
  type PublicMeldView,
  type PublicTileView,
  type ReactionAction,
  type TableActor,
  type TableCommand,
  type TableCommandEnvelope,
  type TableGameCommand,
  type TableReceipt,
  type TableSeat,
  type TableSeatView,
  type ViewerSafeTableSnapshot,
} from "./table-socket-protocol-v2.js";

export type SocketConnectionState =
  | "authentication-required"
  | "connecting"
  | "connected"
  | "protocol-error"
  | "reconnecting"
  | "session-replaced"
  | "stopped"
  | "upgrade-required";

export interface SocketStatus {
  readonly state: SocketConnectionState;
  readonly attempt: number;
  readonly snapshot?: ViewerSafeTableSnapshot;
  readonly latestReceipt?: TableReceipt;
}

export interface SocketStatusMonitor {
  start(onStatus: (status: SocketStatus) => void): () => void;
}

export interface TableSocketCommandController {
  sendCommand(command: TableCommandEnvelope): void;
}

type BrowserLocation = Pick<Location, "origin">;
type SocketFactory = (url: string) => WebSocket;

export function createTableSocketUrl(
  apiBaseUrl: string,
  location: BrowserLocation,
): string {
  const base = apiBaseUrl === "" ? location.origin : apiBaseUrl;
  const url = new URL("/api/table/socket", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("protocolVersion", String(TABLE_PROTOCOL_VERSION));
  return url.toString();
}

export class ReconnectingSocketStatusMonitor
  implements SocketStatusMonitor, TableSocketCommandController
{
  private readonly url: string;
  private readonly createSocket: SocketFactory;
  private activeSocket: WebSocket | undefined;
  private connected = false;

  public constructor(
    url: string,
    createSocket: SocketFactory = (value) => new WebSocket(value),
  ) {
    this.url = url;
    this.createSocket = createSocket;
  }

  public sendCommand(command: TableCommandEnvelope): void {
    validateCommand(command);
    if (!this.connected || !this.activeSocket) {
      throw new Error("Table socket is not connected.");
    }
    this.activeSocket.send(JSON.stringify(command));
  }

  public start(onStatus: (status: SocketStatus) => void): () => void {
    let attempt = 0;
    let stopped = false;
    let hasConnected = false;
    let retryTimer: number | undefined;
    let activeGeneration = 0;
    let lastSnapshot: ViewerSafeTableSnapshot | undefined;
    let latestReceipt: TableReceipt | undefined;

    const publish = (
      state: SocketConnectionState,
      currentAttempt: number,
    ): void => {
      onStatus({
        state,
        attempt: currentAttempt,
        ...(lastSnapshot ? { snapshot: lastSnapshot } : {}),
        ...(latestReceipt ? { latestReceipt } : {}),
      });
    };

    const stopForControl = (
      state: "session-replaced" | "upgrade-required",
      closeCode: number,
      reason: string,
      currentSocket: WebSocket,
    ): void => {
      stopped = true;
      this.connected = false;
      lastSnapshot = undefined;
      latestReceipt = undefined;
      currentSocket.close(closeCode, reason);
      publish(state, 0);
    };

    const handleMessage = (
      message: TableSocketMessage,
      currentSocket: WebSocket,
    ): void => {
      if (message.type === "session/replaced") {
        stopForControl(
          "session-replaced",
          4001,
          "Session replaced",
          currentSocket,
        );
        return;
      }
      if (message.type === "table/upgrade-required") {
        stopForControl(
          "upgrade-required",
          4406,
          "Gameplay protocol upgrade required",
          currentSocket,
        );
        return;
      }
      if (message.type === "table/receipt") {
        latestReceipt = message;
        publish(this.connected ? "connected" : "reconnecting", 0);
        return;
      }
      lastSnapshot = message;
      this.connected = true;
      publish("connected", 0);
    };

    const connect = (): void => {
      const generation = activeGeneration + 1;
      activeGeneration = generation;
      attempt += 1;
      this.connected = false;
      publish(hasConnected ? "reconnecting" : "connecting", attempt);
      const currentSocket = this.createSocket(this.url);
      this.activeSocket = currentSocket;
      const isCurrent = (): boolean =>
        !stopped &&
        activeGeneration === generation &&
        this.activeSocket === currentSocket;

      currentSocket.addEventListener("open", () => {
        if (stopped) {
          currentSocket.close(1000, "Client stopped");
          return;
        }
        if (!isCurrent()) return;
        hasConnected = true;
        attempt = 0;
        if (lastSnapshot) {
          publish("reconnecting", 0);
          currentSocket.send(
            JSON.stringify({
              type: "table/resync",
              protocolVersion: TABLE_PROTOCOL_VERSION,
              lastSeenStateVersion: lastSnapshot.stateVersion,
            }),
          );
        } else {
          this.connected = true;
          publish("connected", 0);
        }
      });
      currentSocket.addEventListener("message", (event) => {
        if (!isCurrent()) return;
        try {
          handleMessage(parseSocketMessage(event), currentSocket);
        } catch {
          stopped = true;
          this.connected = false;
          currentSocket.close(1002, "Unsupported table protocol");
          publish("protocol-error", attempt);
        }
      });
      currentSocket.addEventListener("error", () => {
        if (!isCurrent()) return;
        this.connected = false;
        publish("reconnecting", Math.max(1, attempt));
      });
      currentSocket.addEventListener("close", (event) => {
        if (!isCurrent()) return;
        this.connected = false;
        this.activeSocket = undefined;
        if (event.code === 4001) {
          stopped = true;
          lastSnapshot = undefined;
          latestReceipt = undefined;
          publish("session-replaced", 0);
          return;
        }
        if (event.code === 4406) {
          stopped = true;
          lastSnapshot = undefined;
          latestReceipt = undefined;
          publish("upgrade-required", 0);
          return;
        }
        if (event.code === 1008) {
          stopped = true;
          lastSnapshot = undefined;
          latestReceipt = undefined;
          publish("authentication-required", 0);
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
      const currentSocket = this.activeSocket;
      stopped = true;
      activeGeneration += 1;
      this.connected = false;
      this.activeSocket = undefined;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      currentSocket?.close(1000, "Client stopped");
      publish("stopped", 0);
    };
  }
}
