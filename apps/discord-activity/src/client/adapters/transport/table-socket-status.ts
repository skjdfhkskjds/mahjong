export type SocketConnectionState =
  | "authentication-required"
  | "connecting"
  | "connected"
  | "protocol-error"
  | "reconnecting"
  | "session-replaced"
  | "stopped";

export type TableSeat = "east" | "south" | "west" | "north";

export interface TableActor {
  readonly id: string;
  readonly displayName: string;
}

export interface TableSeatView {
  readonly seat: TableSeat;
  readonly occupant: TableActor | null;
  readonly ready: boolean;
}

export interface ViewerSafeTableSnapshot {
  readonly type: "table/snapshot";
  readonly protocolVersion: 1;
  readonly stateVersion: number;
  readonly view: {
    readonly phase: "lobby";
    readonly tableId: string;
    readonly seats: readonly TableSeatView[];
    readonly spectators: readonly TableActor[];
    readonly viewer:
      | {
          readonly actor: TableActor;
          readonly role: "player";
          readonly seat: TableSeat;
        }
      | { readonly actor: TableActor; readonly role: "spectator" };
  };
}

export interface TableReceipt {
  readonly type: "table/receipt";
  readonly protocolVersion: 1;
  readonly commandId: string;
  readonly stateVersion: number;
  readonly outcome: "applied" | "rejected";
  readonly error?: { readonly code: string; readonly message: string };
}

export interface SessionReplacedMessage {
  readonly type: "session/replaced";
  readonly protocolVersion: 1;
}

export type TableCommandEnvelope =
  | {
      readonly type: "table/command";
      readonly protocolVersion: 1;
      readonly commandId: string;
      readonly expectedStateVersion: number;
      readonly command: {
        readonly type: "lobby/claim-seat";
        readonly seat: TableSeat;
      };
    }
  | {
      readonly type: "table/command";
      readonly protocolVersion: 1;
      readonly commandId: string;
      readonly expectedStateVersion: number;
      readonly command: { readonly type: "lobby/leave-seat" };
    }
  | {
      readonly type: "table/command";
      readonly protocolVersion: 1;
      readonly commandId: string;
      readonly expectedStateVersion: number;
      readonly command: {
        readonly type: "lobby/set-ready";
        readonly ready: boolean;
      };
    };

type TableSocketMessage =
  ViewerSafeTableSnapshot | TableReceipt | SessionReplacedMessage;

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
const tableSeats = ["east", "south", "west", "north"] as const;
const commandIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTableSeat(value: unknown): value is TableSeat {
  return tableSeats.some((seat) => seat === value);
}

function parseActor(value: unknown, field: string): TableActor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "displayName"]) ||
    !nonEmptyString(value["id"]) ||
    !nonEmptyString(value["displayName"])
  ) {
    throw new Error(`Table snapshot has an invalid ${field}.`);
  }
  return { id: value["id"], displayName: value["displayName"] };
}

function actorsEqual(left: TableActor, right: TableActor): boolean {
  return left.id === right.id && left.displayName === right.displayName;
}

export function parseTableSnapshot(value: unknown): ViewerSafeTableSnapshot {
  if (
    !isRecord(value) ||
    value["type"] !== "table/snapshot" ||
    !hasExactKeys(value, ["type", "protocolVersion", "stateVersion", "view"])
  ) {
    throw new Error("Table socket message is not a canonical snapshot.");
  }
  const view = value["view"];
  if (
    !isRecord(view) ||
    view["phase"] !== "lobby" ||
    !hasExactKeys(view, ["phase", "tableId", "seats", "spectators", "viewer"])
  ) {
    throw new Error("Table snapshot has an invalid view.");
  }
  if (
    value["protocolVersion"] !== 1 ||
    !nonNegativeInteger(value["stateVersion"]) ||
    !nonEmptyString(view["tableId"])
  ) {
    throw new Error("Table snapshot has invalid version or identity fields.");
  }

  const seatsValue = view["seats"];
  if (!Array.isArray(seatsValue) || seatsValue.length !== tableSeats.length) {
    throw new Error("Table snapshot must contain exactly four seats.");
  }
  const seats = seatsValue.map((value, index): TableSeatView => {
    const seat = isRecord(value) ? value["seat"] : undefined;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["seat", "occupant", "ready"]) ||
      seat !== tableSeats[index] ||
      !isTableSeat(seat) ||
      typeof value["ready"] !== "boolean"
    ) {
      throw new Error("Table snapshot has invalid or non-canonical seats.");
    }
    const occupant =
      value["occupant"] === null
        ? null
        : parseActor(value["occupant"], "seat occupant");
    if (occupant === null && value["ready"]) {
      throw new Error("An empty table seat cannot be ready.");
    }
    return { seat, occupant, ready: value["ready"] };
  });

  const spectatorsValue = view["spectators"];
  if (!Array.isArray(spectatorsValue)) {
    throw new Error("Table snapshot has invalid spectators.");
  }
  const spectators = spectatorsValue.map((actor) =>
    parseActor(actor, "spectator"),
  );
  const participantIds = [
    ...seats.flatMap((seat) => (seat.occupant ? [seat.occupant.id] : [])),
    ...spectators.map((actor) => actor.id),
  ];
  if (new Set(participantIds).size !== participantIds.length) {
    throw new Error("Table snapshot contains duplicate actor identities.");
  }

  const viewerValue = view["viewer"];
  if (!isRecord(viewerValue)) {
    throw new Error("Table snapshot is missing its viewer.");
  }
  const actor = parseActor(viewerValue["actor"], "viewer actor");
  const role = viewerValue["role"];
  let viewer: ViewerSafeTableSnapshot["view"]["viewer"];
  if (
    role === "player" &&
    hasExactKeys(viewerValue, ["actor", "role", "seat"]) &&
    isTableSeat(viewerValue["seat"])
  ) {
    const ownSeat = seats.find((seat) => seat.seat === viewerValue["seat"]);
    if (!ownSeat?.occupant || !actorsEqual(ownSeat.occupant, actor)) {
      throw new Error("Table snapshot player viewer does not match its seat.");
    }
    viewer = { actor, role, seat: viewerValue["seat"] };
  } else if (
    role === "spectator" &&
    hasExactKeys(viewerValue, ["actor", "role"])
  ) {
    if (!spectators.some((spectator) => actorsEqual(spectator, actor))) {
      throw new Error("Table snapshot spectator viewer is not a spectator.");
    }
    viewer = { actor, role };
  } else {
    throw new Error("Table snapshot has an invalid viewer role or seat.");
  }

  return {
    type: "table/snapshot",
    protocolVersion: 1,
    stateVersion: value["stateVersion"],
    view: {
      phase: "lobby",
      tableId: view["tableId"],
      seats,
      spectators,
      viewer,
    },
  };
}

export function parseTableReceipt(value: unknown): TableReceipt {
  if (
    !isRecord(value) ||
    value["type"] !== "table/receipt" ||
    !hasExactKeys(
      value,
      ["type", "protocolVersion", "commandId", "stateVersion", "outcome"],
      ["error"],
    ) ||
    value["protocolVersion"] !== 1 ||
    typeof value["commandId"] !== "string" ||
    !commandIdPattern.test(value["commandId"]) ||
    !nonNegativeInteger(value["stateVersion"])
  ) {
    throw new Error("Table socket message is not a canonical receipt.");
  }
  if (value["outcome"] === "applied" && value["error"] === undefined) {
    return {
      type: "table/receipt",
      protocolVersion: 1,
      commandId: value["commandId"],
      stateVersion: value["stateVersion"],
      outcome: "applied",
    };
  }
  const error = value["error"];
  if (
    value["outcome"] !== "rejected" ||
    !isRecord(error) ||
    !hasExactKeys(error, ["code", "message"]) ||
    !nonEmptyString(error["code"]) ||
    !nonEmptyString(error["message"])
  ) {
    throw new Error("Table receipt has an invalid outcome or error.");
  }
  return {
    type: "table/receipt",
    protocolVersion: 1,
    commandId: value["commandId"],
    stateVersion: value["stateVersion"],
    outcome: "rejected",
    error: { code: error["code"], message: error["message"] },
  };
}

function parseSocketMessage(event: MessageEvent<unknown>): TableSocketMessage {
  if (typeof event.data !== "string") {
    throw new Error("Table socket messages must be JSON text.");
  }
  try {
    const value = JSON.parse(event.data) as unknown;
    if (isRecord(value) && value["type"] === "session/replaced") {
      if (
        value["protocolVersion"] === 1 &&
        hasExactKeys(value, ["type", "protocolVersion"])
      ) {
        return { type: "session/replaced", protocolVersion: 1 };
      }
      throw new Error("Table socket message is not a canonical control frame.");
    }
    if (isRecord(value) && value["type"] === "table/receipt") {
      return parseTableReceipt(value);
    }
    return parseTableSnapshot(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Table socket message is not valid JSON.", {
        cause: error,
      });
    }
    throw error;
  }
}

function validateCommand(envelope: unknown): void {
  if (
    !isRecord(envelope) ||
    !hasExactKeys(envelope, [
      "type",
      "protocolVersion",
      "commandId",
      "expectedStateVersion",
      "command",
    ]) ||
    envelope["type"] !== "table/command" ||
    envelope["protocolVersion"] !== 1 ||
    typeof envelope["commandId"] !== "string" ||
    !commandIdPattern.test(envelope["commandId"]) ||
    !nonNegativeInteger(envelope["expectedStateVersion"]) ||
    !isRecord(envelope["command"])
  ) {
    throw new Error("Table command is not a canonical envelope.");
  }
  const body = envelope["command"];
  const valid =
    (body["type"] === "lobby/claim-seat" &&
      hasExactKeys(body, ["type", "seat"]) &&
      isTableSeat(body["seat"])) ||
    (body["type"] === "lobby/leave-seat" && hasExactKeys(body, ["type"])) ||
    (body["type"] === "lobby/set-ready" &&
      hasExactKeys(body, ["type", "ready"]) &&
      typeof body["ready"] === "boolean");
  if (!valid) {
    throw new Error("Table command has an invalid command body.");
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
    let socket: WebSocket | undefined;
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

    const connect = (): void => {
      attempt += 1;
      this.connected = false;
      publish(hasConnected ? "reconnecting" : "connecting", attempt);
      socket = this.createSocket(this.url);
      this.activeSocket = socket;

      socket.addEventListener("open", () => {
        if (stopped) {
          socket?.close(1000, "Client stopped");
          return;
        }
        hasConnected = true;
        attempt = 0;
        if (lastSnapshot) {
          publish("reconnecting", 0);
          socket?.send(
            JSON.stringify({
              type: "table/resync",
              protocolVersion: 1,
              lastSeenStateVersion: lastSnapshot.stateVersion,
            }),
          );
        } else {
          this.connected = true;
          publish("connected", 0);
        }
      });
      socket.addEventListener("message", (event) => {
        if (stopped) return;
        try {
          const message = parseSocketMessage(event);
          if (message.type === "session/replaced") {
            stopped = true;
            this.connected = false;
            lastSnapshot = undefined;
            latestReceipt = undefined;
            socket?.close(4001, "Session replaced");
            publish("session-replaced", 0);
            return;
          }
          if (message.type === "table/receipt") {
            latestReceipt = message;
            publish(this.connected ? "connected" : "reconnecting", 0);
          } else {
            lastSnapshot = message;
            this.connected = true;
            publish("connected", 0);
          }
        } catch {
          stopped = true;
          this.connected = false;
          socket?.close(1002, "Unsupported table protocol");
          publish("protocol-error", attempt);
        }
      });
      socket.addEventListener("close", (event) => {
        if (stopped) return;
        this.connected = false;
        if (event.code === 4001) {
          stopped = true;
          lastSnapshot = undefined;
          latestReceipt = undefined;
          publish("session-replaced", 0);
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
      stopped = true;
      this.connected = false;
      this.activeSocket = undefined;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close(1000, "Client stopped");
      publish("stopped", 0);
    };
  }
}
