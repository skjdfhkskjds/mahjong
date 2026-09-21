import {
  parseSocketMessage,
  TABLE_PROTOCOL_VERSION,
  validateCommand,
  type TableCommandEnvelope,
  type TableSocketMessage,
} from "./table-socket-protocol-v2.js";
import {
  startTableSocketHeartbeat,
  TABLE_HEARTBEAT_READY,
  TABLE_HEARTBEAT_RESPONSE,
  type TableSocketHeartbeat,
} from "./table-socket-heartbeat.js";
import {
  assertNever,
  isSocketTerminal,
  transitionSocket,
  type SocketStatus,
  type SocketTransition,
} from "./table-socket-lifecycle.js";

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

export { type SocketStatus } from "./table-socket-lifecycle.js";

export type TableMessageMap = {
  readonly [K in TableSocketMessage["type"]]: Extract<
    TableSocketMessage,
    { readonly type: K }
  >;
};

type MessageListener<K extends keyof TableMessageMap> = (
  message: TableMessageMap[K],
) => void;
type MessageListeners = {
  [K in keyof TableMessageMap]: Set<MessageListener<K>>;
};

export interface SocketStatusMonitor {
  start(onStatus: (status: SocketStatus) => void): () => void;
  subscribe<K extends keyof TableMessageMap>(
    type: K,
    listener: MessageListener<K>,
  ): () => void;
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
  url.searchParams.set("heartbeat", "1");
  return url.toString();
}

interface Connection {
  readonly socket: WebSocket;
  readonly detach: () => void;
}

interface SocketRun {
  status: SocketStatus;
  readonly onStatus: (status: SocketStatus) => void;
  connection: Connection | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  lastSeenStateVersion: number;
  heartbeat: TableSocketHeartbeat | undefined;
}

/** One native connection with synchronous, ordered, separately typed delivery. */
export class ReconnectingSocketStatusMonitor
  implements SocketStatusMonitor, TableSocketCommandController
{
  private readonly url: string;
  private readonly createSocket: SocketFactory;
  private readonly heartbeatRequested: boolean;
  private run: SocketRun | undefined;
  private readonly messages: MessageListeners = {
    "table/snapshot": new Set(),
    "table/receipt": new Set(),
    "session/replaced": new Set(),
    "table/upgrade-required": new Set(),
  };
  private readonly events: (() => void)[] = [];
  private delivering = false;

  public constructor(
    url: string,
    createSocket: SocketFactory = (value) => new WebSocket(value),
  ) {
    this.url = url;
    this.createSocket = createSocket;
    const heartbeatVersions = new URL(url).searchParams.getAll("heartbeat");
    this.heartbeatRequested =
      heartbeatVersions.length === 1 && heartbeatVersions[0] === "1";
  }

  /** Subscriptions survive a run restart; their owner must unsubscribe on disposal. */
  public subscribe<K extends keyof TableMessageMap>(
    type: K,
    listener: MessageListener<K>,
  ): () => void {
    const listeners = this.messages[type];
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  public sendCommand(command: TableCommandEnvelope): void {
    validateCommand(command);
    const run = this.run;
    if (run?.status.state !== "connected" || !run.connection) {
      throw new Error("Table socket is not connected.");
    }
    // The native closing handshake can precede its close callback; send() may
    // silently discard then. Preserve that callback's terminal close code.
    if (run.connection.socket.readyState !== WebSocket.OPEN) {
      this.advance(run, { type: "error" });
      throw new Error("Table socket is not connected.");
    }
    try {
      run.connection.socket.send(JSON.stringify(command));
    } catch {
      this.advance(run, { type: "close", code: 1006 });
      throw new Error("Table command could not be sent.");
    }
  }

  public start(onStatus: (status: SocketStatus) => void): () => void {
    const previous = this.run;
    const run: SocketRun = {
      status: transitionSocket({ state: "stopped" }, { type: "start" }),
      onStatus,
      connection: undefined,
      retryTimer: undefined,
      lastSeenStateVersion: 0,
      heartbeat: undefined,
    };
    // Replace ownership before invoking callbacks: a reentrant start wins.
    this.run = run;
    if (previous && previous.status.state !== "stopped") {
      previous.status = { state: "stopped" };
      this.cleanup(previous);
      this.notify(previous);
    }
    if (this.run === run) {
      this.notify(run);
      this.connect(run);
    }
    return () => {
      if (this.run !== run || run.status.state === "stopped") {
        return;
      }
      this.advance(run, { type: "stop" });
    };
  }

  private notify(run: SocketRun): void {
    this.invoke(() => {
      run.onStatus(run.status);
    });
  }

  private invoke(callback: () => void): void {
    try {
      callback();
    } catch {
      // Consumer exceptions cannot expose payloads, become protocol failures,
      // interrupt another subscriber, or skip lifecycle cleanup.
    }
  }

  private enqueue(callback: () => void): void {
    this.events.push(callback);
    if (this.delivering) {
      return;
    }
    this.delivering = true;
    try {
      let next = this.events.shift();
      while (next) {
        next();
        next = this.events.shift();
      }
    } finally {
      this.delivering = false;
    }
  }

  private emit<K extends keyof TableMessageMap>(
    run: SocketRun,
    type: K,
    message: TableMessageMap[K],
  ): void {
    const listeners = this.messages[type];
    const status = run.status;
    for (const listener of [...listeners]) {
      if (this.run !== run || run.status !== status) {
        return;
      }
      if (listeners.has(listener)) {
        this.invoke(() => {
          listener(message);
        });
      }
    }
  }

  private stopHeartbeat(run: SocketRun): void {
    run.heartbeat?.stop();
    run.heartbeat = undefined;
  }

  private cleanup(run: SocketRun, closeCode?: number): void {
    this.stopHeartbeat(run);
    const connection = run.connection;
    run.connection = undefined;
    if (run.retryTimer !== undefined) {
      clearTimeout(run.retryTimer);
    }
    run.retryTimer = undefined;
    if (!connection) {
      return;
    }
    connection.detach();
    const code =
      closeCode ??
      (run.status.state === "session-replaced"
        ? 4001
        : run.status.state === "upgrade-required"
          ? 4406
          : 1000);
    // Browser clients may send only 1000 or application close codes (3000–4999).
    try {
      connection.socket.close(code);
    } catch {
      // Ownership and listeners are already retired, even if platform close fails.
    }
  }

  private advance(run: SocketRun, input: SocketTransition): void {
    if (this.run !== run) {
      return;
    }
    const next = transitionSocket(run.status, input);
    if (next === run.status) {
      return;
    }
    run.status = next;
    if (isSocketTerminal(next) || next.state === "reconnecting") {
      this.cleanup(run, input.type === "heartbeat-timeout" ? 4000 : undefined);
    }
    if (next.state === "disconnecting") {
      this.stopHeartbeat(run);
    }
    if (next.state === "reconnecting") {
      run.retryTimer = setTimeout(() => {
        this.enqueue(() => {
          if (this.run !== run || run.status !== next) {
            return;
          }
          run.retryTimer = undefined;
          this.advance(run, { type: "retry" });
          this.connect(run);
        });
      }, next.delayMs);
    }
    this.notify(run);
  }

  private connect(run: SocketRun): void {
    if (this.run !== run || run.status.state !== "connecting") {
      return;
    }
    const connecting = run.status;
    let socket: WebSocket;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.advance(run, { type: "close", code: 1006 });
      return;
    }
    // Factory hooks may synchronously stop or replace this run.
    if (this.run !== run || run.status !== connecting) {
      socket.close(1000);
      return;
    }
    const current = (): boolean =>
      this.run === run &&
      run.connection?.socket === socket &&
      !isSocketTerminal(run.status);
    const open = (): void => {
      this.enqueue(() => {
        if (!current() || run.status.state !== "connecting") {
          return;
        }
        this.advance(run, { type: "open" });
        if (!current()) {
          return;
        }
        try {
          // Initial and reopened connections take the same initialization path.
          socket.send(
            JSON.stringify({
              type: "table/resync",
              protocolVersion: TABLE_PROTOCOL_VERSION,
              lastSeenStateVersion: run.lastSeenStateVersion,
            }),
          );
        } catch {
          this.advance(run, { type: "close", code: 1006 });
        }
      });
    };
    const message = (event: MessageEvent): void => {
      this.enqueue(() => {
        if (!current() || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        if (this.heartbeatRequested && event.data === TABLE_HEARTBEAT_READY) {
          if (
            run.status.state === "awaiting-snapshot" ||
            run.status.state === "connected"
          ) {
            run.heartbeat ??= this.startHeartbeat(run, socket, current);
          }
          return;
        }
        if (
          this.heartbeatRequested &&
          event.data === TABLE_HEARTBEAT_RESPONSE
        ) {
          run.heartbeat?.acknowledge();
          return;
        }
        let parsed: TableSocketMessage;
        try {
          parsed = parseSocketMessage(event);
        } catch {
          this.advance(run, { type: "protocol-error" });
          return;
        }
        this.deliverMessage(run, parsed, current);
      });
    };
    const error = (): void => {
      this.enqueue(() => {
        if (current()) {
          this.advance(run, { type: "error" });
        }
      });
    };
    const close = (event: CloseEvent): void => {
      this.enqueue(() => {
        if (current()) {
          this.advance(run, { type: "close", code: event.code });
        }
      });
    };
    run.connection = {
      socket,
      detach: () => {
        socket.removeEventListener("open", open);
        socket.removeEventListener("message", message);
        socket.removeEventListener("error", error);
        socket.removeEventListener("close", close);
      },
    };
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("error", error);
    socket.addEventListener("close", close);
  }

  private startHeartbeat(
    run: SocketRun,
    socket: WebSocket,
    current: () => boolean,
  ): TableSocketHeartbeat {
    const heartbeat = startTableSocketHeartbeat({
      send: (frame) => {
        if (!current() || run.heartbeat !== heartbeat) {
          heartbeat.stop();
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) {
          this.advance(run, { type: "error" });
          return;
        }
        socket.send(frame);
      },
      onTimeout: () => {
        this.enqueue(() => {
          if (!current() || run.heartbeat !== heartbeat) return;
          // A pending native terminal close (including deliberate departure)
          // must win over heartbeat retry while the handshake is closing.
          this.advance(run, {
            type:
              socket.readyState === WebSocket.OPEN
                ? "heartbeat-timeout"
                : "error",
          });
        });
      },
      scheduler: {
        now: () => performance.now(),
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (timer) => {
          window.clearTimeout(timer);
        },
      },
    });
    return heartbeat;
  }

  private deliverMessage(
    run: SocketRun,
    message: TableSocketMessage,
    current: () => boolean,
  ): void {
    switch (message.type) {
      case "table/snapshot":
        if (
          run.status.state !== "awaiting-snapshot" &&
          run.status.state !== "connected"
        ) {
          return;
        }
        run.lastSeenStateVersion = message.stateVersion;
        this.emit(run, message.type, message);
        // Application receives the fresh snapshot before commands are enabled.
        if (current()) {
          this.advance(run, { type: "snapshot" });
        }
        return;
      case "table/receipt":
        this.emit(run, message.type, message);
        return;
      case "session/replaced":
      case "table/upgrade-required":
        // Retire the connection and publish terminal state before the control.
        this.advance(run, { type: message.type });
        if (
          this.run === run &&
          run.status.state ===
            (message.type === "session/replaced"
              ? "session-replaced"
              : "upgrade-required")
        ) {
          this.emit(run, message.type, message);
        }
        return;
      default:
        assertNever(message);
    }
  }
}
