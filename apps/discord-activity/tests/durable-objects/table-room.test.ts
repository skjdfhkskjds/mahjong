import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applyGameCommand,
  applyGameCommandV2,
  assertGameInvariants,
  canonicalEventHashPayload,
  canonicalGameEventJson,
  canonicalGameJson,
  decideReactionExpiration,
  decodeCanonicalVersionedGameJson,
  reduceVersionedGameEvent,
  startHongKongV1Game,
  startHongKongV2Game,
  type CanonicalGameStateV2,
  type VersionedHongKongGameEvent,
} from "@mahjong/rules-hong-kong";

import type { TableRoom } from "../../src/worker/durable-objects/table-room.js";
import { scheduleDeadline } from "../../src/worker/durable-objects/table-room/deadline-queue.js";
import {
  persistPreparedGameBatch,
  prepareGameEventBatch,
} from "../../src/worker/durable-objects/table-room/table-room-game-store.js";
import { tableRoomV1Schema } from "../fixtures/table-room-v1-schema.js";

interface Binding {
  readonly bindingGeneration: number;
  readonly bindingProof: string;
  readonly role: "owner";
  readonly tableId: string;
  readonly version: 1;
}

interface Capability {
  readonly capability: string;
  readonly expiresAt: number;
  readonly version: 1;
}

interface SnapshotMessage {
  readonly protocolVersion: number;
  readonly stateVersion: number;
  readonly type: string;
  readonly view: {
    readonly phase: string;
    readonly game?: {
      readonly phase: string;
      readonly players?: readonly {
        readonly melds?: readonly {
          readonly claimedTileId?: number;
          readonly exposure: string;
          readonly kind: string;
          readonly kongKind?: string;
          readonly sourceSeat?: string;
          readonly tileIds: readonly { readonly id: number }[];
        }[];
        readonly seat: string;
      }[];
      readonly reaction?: { readonly windowId: string };
      readonly result?: {
        readonly awardedPatterns: readonly { readonly id: string }[];
        readonly cappedFaan: number;
        readonly isLegalWin: boolean;
        readonly source: { readonly type: string };
        readonly winnerSeat: string;
      };
      readonly turn: string;
      readonly viewerActions?: {
        readonly reaction?: {
          readonly actions: readonly unknown[];
          readonly status: "open" | "submitted";
        };
        readonly self?: readonly { readonly type: string }[];
      };
      readonly viewerHand?: readonly { readonly id: number }[];
      readonly wallRemaining: number;
    };
    readonly tableId: string;
    readonly seats: readonly {
      readonly autopilot: boolean;
      readonly occupant: {
        readonly displayName: string;
        readonly id: string;
      } | null;
      readonly ready: boolean;
      readonly seat: string;
    }[];
    readonly spectators: readonly {
      readonly displayName: string;
      readonly id: string;
    }[];
    readonly viewer: {
      readonly actor: { readonly displayName: string; readonly id: string };
      readonly role: "player" | "spectator";
      readonly seat?: string;
    };
  };
}

interface ReceiptMessage {
  readonly commandId: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly outcome: "applied" | "rejected";
  readonly protocolVersion: 2;
  readonly stateVersion: number;
  readonly type: "table/receipt";
}

const owner = { displayName: "Table Owner", id: "discord:owner" } as const;
const member = { displayName: "Invited Member", id: "discord:member" } as const;

function gamePlayerAt(
  state: CanonicalGameStateV2,
  seat: CanonicalGameStateV2["turn"],
) {
  switch (seat) {
    case "east":
      return state.players.east;
    case "south":
      return state.players.south;
    case "west":
      return state.players.west;
    case "north":
      return state.players.north;
  }
  throw new Error("Fixture has an unsupported seat.");
}

type PhysicalTileId = CanonicalGameStateV2["players"]["east"]["hand"][number];
type GameSeatName = "east" | "north" | "south" | "west";

function swapPhysicalTiles(
  state: CanonicalGameStateV2,
  left: PhysicalTileId,
  right: PhysicalTileId,
): CanonicalGameStateV2 {
  const swap = (id: PhysicalTileId): PhysicalTileId =>
    id === left ? right : id === right ? left : id;
  const players = Object.fromEntries(
    (["east", "south", "west", "north"] as const).map((seat) => {
      const player = state.players[seat];
      return [
        seat,
        {
          ...player,
          bonuses: player.bonuses.map(swap),
          discards: player.discards.map(swap),
          hand: player.hand.map(swap),
          melds: player.melds.map((meld) => ({
            ...meld,
            ...(meld.claimedTileId === undefined
              ? {}
              : { claimedTileId: swap(meld.claimedTileId) }),
            tileIds: meld.tileIds
              .map(swap)
              .sort((a, b) => Number(a) - Number(b)),
          })),
        },
      ] as const;
    }),
  ) as unknown as CanonicalGameStateV2["players"];
  return {
    ...state,
    players,
    reactionWindow:
      state.reactionWindow === null
        ? null
        : {
            ...state.reactionWindow,
            sourceTileId: swap(state.reactionWindow.sourceTileId),
          },
    turnProvenance: {
      ...state.turnProvenance,
      lastAcquiredTileId:
        state.turnProvenance.lastAcquiredTileId === null
          ? null
          : swap(state.turnProvenance.lastAcquiredTileId),
    },
    wall: { ...state.wall, order: state.wall.order.map(swap) },
  };
}

function placePhysicalTiles(
  state: CanonicalGameStateV2,
  placements: readonly {
    readonly index: number;
    readonly seat: GameSeatName;
    readonly tileId: number;
  }[],
): CanonicalGameStateV2 {
  let next = state;
  for (const placement of placements) {
    const current = next.players[placement.seat].hand[placement.index];
    if (current === undefined) throw new Error("Fixture hand slot is absent.");
    next = swapPhysicalTiles(next, current, placement.tileId as PhysicalTileId);
  }
  assertGameInvariants(next);
  return next;
}

async function sha256HexForTest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function installGameChain(stub: DurableObjectStub<TableRoom>): Promise<{
  readonly genesisStateJson: string;
}> {
  const started = startHongKongV1Game(
    {
      east: "actor:east",
      south: "actor:south",
      west: "actor:west",
      north: "actor:north",
    },
    Uint8Array.from({ length: 1_028 }, (_, index) => (index * 73 + 9) & 0xff),
  );
  const openingTile = started.state.players.east.hand[0];
  if (openingTile === undefined) throw new Error("Dealer has no opening tile.");
  const discard = applyGameCommand(
    started.state,
    started.state.players.east.actorId,
    { type: "game/discard", tileId: openingTile },
  );
  if (!discard.accepted || discard.state === undefined)
    throw new Error("Unable to build persisted test game.");
  const finalState = discard.state;
  const firstHash = await sha256HexForTest(
    canonicalEventHashPayload(null, started.event),
  );
  expect(firstHash).toBe(
    "d589f4c5af7c9328a38a2d5630de04fb670e7dacb2e9ab1e474d487e6705c2b9",
  );
  const secondHash = await sha256HexForTest(
    canonicalEventHashPayload(firstHash, discard.event),
  );
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO canonical_game_state (singleton, state_json, last_event_hash) VALUES (1, ?, ?)",
      canonicalGameJson(finalState),
      secondHash,
    );
    state.storage.sql.exec(
      "INSERT INTO game_events (sequence, event_json, previous_hash, event_hash) VALUES (1, ?, NULL, ?), (2, ?, ?, ?)",
      canonicalGameEventJson(started.event),
      firstHash,
      canonicalGameEventJson(discard.event),
      firstHash,
      secondHash,
    );
  });
  return { genesisStateJson: canonicalGameJson(started.state) };
}

function tableRoom(name: string): DurableObjectStub<TableRoom> {
  return (
    env as unknown as { TABLE_ROOM: DurableObjectNamespace<TableRoom> }
  ).TABLE_ROOM.getByName(name);
}

async function post(
  stub: DurableObjectStub<TableRoom>,
  pathname: string,
  body: object,
): Promise<Response> {
  return stub.fetch(
    new Request(`https://table-room.internal${pathname}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  );
}

async function createTable(
  stub: DurableObjectStub<TableRoom>,
  tableId: string,
  operationId = crypto.randomUUID(),
): Promise<{ readonly binding: Binding; readonly request: object }> {
  const request = {
    version: 1,
    operationId,
    instanceId: "instance-original",
    actor: owner,
    deadlineAt: Date.now() + 60_000,
    intent: { kind: "create" },
  } as const;
  const response = await post(stub, "/internal/bindings/apply", request);
  expect(response.status).toBe(200);
  const binding = await response.json<Binding>();
  expect(binding).toMatchObject({
    version: 1,
    tableId,
    bindingGeneration: 1,
    role: "owner",
  });
  expect(binding.bindingProof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return { binding, request };
}

function bindingAuthorization(
  binding: Binding,
  instanceId = "instance-original",
) {
  return {
    instanceId,
    bindingGeneration: binding.bindingGeneration,
    bindingProof: binding.bindingProof,
  };
}

async function activateSession(
  stub: DurableObjectStub<TableRoom>,
  binding: Binding,
  actorId: string,
  sessionGeneration: number,
  instanceId = "instance-original",
): Promise<Response> {
  return post(stub, "/internal/sessions/activate", {
    version: 1,
    ...bindingAuthorization(binding, instanceId),
    actorId,
    sessionGeneration,
  });
}

function nextMessage<T = SnapshotMessage>(socket: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(JSON.parse(String(event.data)) as T);
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Snapshot parsing failed."),
          );
        }
      },
      { once: true },
    );
  });
}

function sendCommand(
  socket: WebSocket,
  commandId: string,
  expectedStateVersion: number,
  command: object,
): Promise<ReceiptMessage> {
  const receipt = nextMessage<ReceiptMessage>(socket);
  socket.send(commandMessage(commandId, expectedStateVersion, command));
  return receipt;
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
}

function nextMessages<T>(socket: WebSocket, count: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const messages: T[] = [];
    const listener = (event: MessageEvent) => {
      try {
        messages.push(JSON.parse(String(event.data)) as T);
        if (messages.length === count) {
          socket.removeEventListener("message", listener);
          resolve(messages);
        }
      } catch (error) {
        socket.removeEventListener("message", listener);
        reject(
          error instanceof Error
            ? error
            : new Error("Table message parsing failed."),
        );
      }
    };
    socket.addEventListener("message", listener);
  });
}

function nextReceipt(socket: WebSocket): Promise<ReceiptMessage> {
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      try {
        const value = JSON.parse(String(event.data)) as {
          readonly type?: unknown;
        };
        if (value.type === "table/receipt") {
          socket.removeEventListener("message", listener);
          resolve(value as ReceiptMessage);
        }
      } catch (error) {
        socket.removeEventListener("message", listener);
        reject(
          error instanceof Error
            ? error
            : new Error("Table receipt parsing failed."),
        );
      }
    };
    socket.addEventListener("message", listener);
  });
}

function commandMessage(
  commandId: string,
  expectedStateVersion: number,
  command: object,
): string {
  return JSON.stringify({
    type: "table/command",
    protocolVersion: 2,
    commandId,
    expectedStateVersion,
    command,
  });
}

function displayNameHeader(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function connect(
  stub: DurableObjectStub<TableRoom>,
  binding: Binding,
  sessionGeneration: number,
  actor: { readonly displayName: string; readonly id: string } = owner,
  instanceId = "instance-original",
  sessionExpiresAt = Date.now() + 60_000,
): Promise<Response> {
  return stub.fetch(
    new Request("https://table-room.internal/connect?protocolVersion=2", {
      headers: {
        Upgrade: "websocket",
        "X-Mahjong-Actor-Id": actor.id,
        "X-Mahjong-Binding-Generation": String(binding.bindingGeneration),
        "X-Mahjong-Binding-Proof": binding.bindingProof,
        "X-Mahjong-Connection-Generation": crypto.randomUUID(),
        "X-Mahjong-Display-Name": displayNameHeader(actor.displayName),
        "X-Mahjong-Instance-Id": instanceId,
        "X-Mahjong-Session-Expires-At": String(sessionExpiresAt),
        "X-Mahjong-Session-Generation": String(sessionGeneration),
        "X-Mahjong-Table-Id": binding.tableId,
      },
    }),
  );
}

async function openSocket(
  stub: DurableObjectStub<TableRoom>,
  binding: Binding,
  sessionGeneration: number,
  actor: { readonly displayName: string; readonly id: string } = owner,
  sessionExpiresAt = Date.now() + 60_000,
): Promise<{ readonly initial: SnapshotMessage; readonly socket: WebSocket }> {
  const upgrade = await connect(
    stub,
    binding,
    sessionGeneration,
    actor,
    "instance-original",
    sessionExpiresAt,
  );
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket;
  if (socket === null) throw new Error("WebSocket upgrade returned no socket.");
  const initial = nextMessage(socket);
  socket.accept();
  return { initial: await initial, socket };
}

async function addMember(
  stub: DurableObjectStub<TableRoom>,
  binding: Binding,
  actor: { readonly displayName: string; readonly id: string },
  sessionGeneration = 1,
): Promise<void> {
  const invitationResponse = await post(stub, "/internal/invitations/create", {
    version: 1,
    ...bindingAuthorization(binding),
    actorId: owner.id,
    invitedActorId: actor.id,
    now: Date.now(),
    sessionGeneration: 1,
  });
  expect(invitationResponse.status).toBe(200);
  const invitation = await invitationResponse.json<Capability>();
  const activation = await activateSession(
    stub,
    binding,
    actor.id,
    sessionGeneration,
  );
  expect(activation.status).toBe(403);
  await activation.body?.cancel();
  const redemption = await post(stub, "/internal/invitations/redeem", {
    version: 1,
    ...bindingAuthorization(binding),
    actor,
    capability: invitation.capability,
    now: Date.now(),
    sessionGeneration,
  });
  expect(redemption.status).toBe(200);
  await redemption.body?.cancel();
}

async function installTableGameFixture(
  stub: DurableObjectStub<TableRoom>,
  binding: Binding,
  actors: Readonly<
    Record<
      "east" | "north" | "south" | "west",
      { readonly displayName: string; readonly id: string }
    >
  >,
  events: Parameters<typeof prepareGameEventBatch>[1],
): Promise<number> {
  const activation = await activateSession(stub, binding, owner.id, 1);
  expect(activation.status).toBe(200);
  await activation.body?.cancel();
  for (const actor of [actors.south, actors.west, actors.north]) {
    await addMember(stub, binding, actor);
  }
  const prepared = await prepareGameEventBatch(undefined, events);
  await runInDurableObject(stub, (_instance, state) => {
    persistPreparedGameBatch(state.storage, prepared, (sql) => {
      for (const [seat, actor] of Object.entries(actors)) {
        sql.exec(
          "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES (?, ?, ?, 1)",
          seat,
          actor.id,
          actor.displayName,
        );
      }
    });
  });
  return runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql
        .exec<{ state_version: number }>(
          "SELECT state_version FROM lobby_state WHERE singleton = 1",
        )
        .one().state_version,
  );
}

describe("TableRoom authority", () => {
  it("persists a create receipt and replays it identically after eviction", async () => {
    const tableId = `create-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const operationId = crypto.randomUUID();
    const created = await createTable(stub, tableId, operationId);

    await evictDurableObject(stub);
    const replay = await post(
      stub,
      "/internal/bindings/apply",
      created.request,
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(created.binding);

    const collision = await post(stub, "/internal/bindings/apply", {
      ...created.request,
      actor: { ...owner, displayName: "Changed Owner" },
    });
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({
      error: { code: "operation-collision" },
    });

    const secondCreate = await post(stub, "/internal/bindings/apply", {
      ...created.request,
      operationId: crypto.randomUUID(),
    });
    expect(secondCreate.status).toBe(409);
    await expect(secondCreate.json()).resolves.toMatchObject({
      error: { code: "table-already-created" },
    });
  });

  it("expires only uncommitted pending receipts after their deadline", async () => {
    const expiredTableId = `expired-${crypto.randomUUID()}`;
    const expiredStub = tableRoom(expiredTableId);
    const expiredRequest = {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-expired",
      actor: owner,
      deadlineAt: 0,
      intent: { kind: "create" },
    } as const;
    const canonicalExpiredRequest = JSON.stringify({
      actor: expiredRequest.actor,
      deadlineAt: expiredRequest.deadlineAt,
      instanceId: expiredRequest.instanceId,
      intent: expiredRequest.intent,
      operationId: expiredRequest.operationId,
      version: 1,
    });
    await runInDurableObject(expiredStub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO binding_receipts (operation_id, request_json, status, response_json, http_status, created_at, updated_at) VALUES (?, ?, 'pending', NULL, 0, 0, 0)",
        expiredRequest.operationId,
        canonicalExpiredRequest,
      );
    });
    const expired = await post(
      expiredStub,
      "/internal/bindings/apply",
      expiredRequest,
    );
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "binding-expired" },
    });
    await expect(
      runInDurableObject(expiredStub, (_instance, state) => ({
        receipts: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM binding_receipts WHERE status = 'rejected'",
          )
          .one().count,
        tables: state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM table_record")
          .one().count,
      })),
    ).resolves.toEqual({ receipts: 1, tables: 0 });

    const committedTableId = `committed-${crypto.randomUUID()}`;
    const committedStub = tableRoom(committedTableId);
    const operationId = crypto.randomUUID();
    const created = await createTable(
      committedStub,
      committedTableId,
      operationId,
    );
    const committedRetry = {
      ...created.request,
      deadlineAt: 0,
    };
    const canonicalCommittedRetry = JSON.stringify({
      actor: owner,
      deadlineAt: 0,
      instanceId: "instance-original",
      intent: { kind: "create" },
      operationId,
      version: 1,
    });
    await runInDurableObject(committedStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE binding_receipts SET request_json = ?, status = 'pending', response_json = NULL, http_status = 0 WHERE operation_id = ?",
        canonicalCommittedRetry,
        operationId,
      );
    });
    const repaired = await post(
      committedStub,
      "/internal/bindings/apply",
      committedRetry,
    );
    expect(repaired.status).toBe(200);
    await expect(repaired.json()).resolves.toEqual(created.binding);
  });

  it("issues actor-bound invitations and owner-only resume capabilities", async () => {
    const tableId = `access-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();

    const invitationResponse = await post(
      stub,
      "/internal/invitations/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        invitedActorId: member.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(invitationResponse.status).toBe(200);
    const invitation = await invitationResponse.json<Capability>();
    expect(invitation.capability).toContain(`v1.${tableId}.`);

    const wrongActorActivation = await activateSession(
      stub,
      binding,
      "discord:wrong",
      1,
    );
    expect(wrongActorActivation.status).toBe(403);
    await wrongActorActivation.body?.cancel();
    const wrongActor = await post(stub, "/internal/invitations/redeem", {
      version: 1,
      ...authorization,
      actor: { displayName: "Wrong Actor", id: "discord:wrong" },
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 1,
    });
    expect(wrongActor.status).toBe(403);
    await wrongActor.body?.cancel();

    const candidateActivation = await activateSession(
      stub,
      binding,
      member.id,
      1,
    );
    expect(candidateActivation.status).toBe(403);
    await candidateActivation.body?.cancel();
    const redeemBody = {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 1,
    } as const;
    const redeemed = await post(
      stub,
      "/internal/invitations/redeem",
      redeemBody,
    );
    expect(redeemed.status).toBe(200);
    await expect(redeemed.json()).resolves.toEqual({
      version: 1,
      tableId,
      role: "member",
    });
    const memberActivation = await post(stub, "/internal/sessions/activate", {
      version: 1,
      ...authorization,
      actorId: member.id,
      sessionGeneration: 1,
    });
    await expect(memberActivation.json()).resolves.toEqual({
      version: 1,
      active: true,
      role: "member",
    });
    const invitationReplay = await post(
      stub,
      "/internal/invitations/redeem",
      redeemBody,
    );
    expect(invitationReplay.status).toBe(410);
    await invitationReplay.body?.cancel();

    const memberResume = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...authorization,
        actorId: member.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(memberResume.status).toBe(403);
    await memberResume.body?.cancel();

    const resumeResponse = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(resumeResponse.status).toBe(200);
    const resumeCapability = await resumeResponse.json<Capability>();
    const resumeRequest = {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-resumed",
      actor: owner,
      deadlineAt: Date.now() + 60_000,
      intent: { kind: "resume", capability: resumeCapability.capability },
    } as const;
    const resumedResponse = await post(
      stub,
      "/internal/bindings/apply",
      resumeRequest,
    );
    expect(resumedResponse.status).toBe(200);
    const resumed = await resumedResponse.json<Binding>();
    expect(resumed).toMatchObject({
      tableId,
      bindingGeneration: 2,
      role: "owner",
    });
    expect(resumed.bindingProof).not.toBe(binding.bindingProof);

    await evictDurableObject(stub);
    const resumeReplay = await post(
      stub,
      "/internal/bindings/apply",
      resumeRequest,
    );
    expect(resumeReplay.status).toBe(200);
    await expect(resumeReplay.json()).resolves.toEqual(resumed);

    const consumed = await post(stub, "/internal/bindings/apply", {
      ...resumeRequest,
      operationId: crypto.randomUUID(),
    });
    expect(consumed.status).toBe(410);
    await expect(consumed.json()).resolves.toMatchObject({
      error: { code: "capability-consumed" },
    });
  });

  it("serializes duplicate and competing resume operations without storing secrets", async () => {
    const tableId = `resume-race-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();
    const firstCapabilityResponse = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...bindingAuthorization(binding),
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    const firstCapability = await firstCapabilityResponse.json<Capability>();
    const duplicateRequest = {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-duplicate-resume",
      actor: owner,
      deadlineAt: Date.now() + 60_000,
      intent: { kind: "resume", capability: firstCapability.capability },
    } as const;

    const duplicateResponses = await Promise.all([
      post(stub, "/internal/bindings/apply", duplicateRequest),
      post(stub, "/internal/bindings/apply", duplicateRequest),
    ]);
    expect(duplicateResponses.map(({ status }) => status)).toEqual([200, 200]);
    const duplicateResults = await Promise.all(
      duplicateResponses.map((response) => response.json<Binding>()),
    );
    expect(duplicateResults[1]).toEqual(duplicateResults[0]);
    const resumed = duplicateResults[0];
    if (resumed === undefined) throw new Error("Resume result is missing.");

    const storedRequest = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ request_json: string }>(
            "SELECT request_json FROM binding_receipts WHERE operation_id = ?",
            duplicateRequest.operationId,
          )
          .one().request_json,
    );
    const capabilitySecret = firstCapability.capability.split(".").at(-1);
    expect(storedRequest).not.toContain(firstCapability.capability);
    expect(capabilitySecret).toBeDefined();
    expect(storedRequest).not.toContain(capabilitySecret ?? "");

    const resumedActivation = await activateSession(
      stub,
      resumed,
      owner.id,
      1,
      "instance-duplicate-resume",
    );
    expect(resumedActivation.status).toBe(200);
    await resumedActivation.body?.cancel();

    const secondCapabilityResponse = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...bindingAuthorization(resumed, "instance-duplicate-resume"),
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    const secondCapability = await secondCapabilityResponse.json<Capability>();
    const firstOperation = {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-competing-a",
      actor: owner,
      deadlineAt: Date.now() + 60_000,
      intent: { kind: "resume", capability: secondCapability.capability },
    } as const;
    const secondOperation = {
      ...firstOperation,
      operationId: crypto.randomUUID(),
      instanceId: "instance-competing-b",
    } as const;
    const competingResponses = await Promise.all([
      post(stub, "/internal/bindings/apply", firstOperation),
      post(stub, "/internal/bindings/apply", secondOperation),
    ]);
    expect(competingResponses.map(({ status }) => status).toSorted()).toEqual([
      200, 410,
    ]);
    const winnerIndex = competingResponses.findIndex(
      ({ status }) => status === 200,
    );
    const winningResponse = competingResponses[winnerIndex];
    if (winningResponse === undefined)
      throw new Error("A resume operation did not win.");
    const winningBinding = await winningResponse.json<Binding>();
    const winningRequest = winnerIndex === 0 ? firstOperation : secondOperation;
    await competingResponses[1 - winnerIndex]?.body?.cancel();
    const replay = await post(stub, "/internal/bindings/apply", winningRequest);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(winningBinding);
  });

  it("consumes an invitation exactly once under concurrent redemption", async () => {
    const tableId = `invite-race-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();
    const invitationResponse = await post(
      stub,
      "/internal/invitations/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        invitedActorId: member.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    const invitation = await invitationResponse.json<Capability>();
    const candidateActivation = await activateSession(
      stub,
      binding,
      member.id,
      1,
    );
    expect(candidateActivation.status).toBe(403);
    await candidateActivation.body?.cancel();
    const redeemBody = {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 1,
    } as const;
    const responses = await Promise.all([
      post(stub, "/internal/invitations/redeem", redeemBody),
      post(stub, "/internal/invitations/redeem", redeemBody),
    ]);
    expect(responses.map(({ status }) => status).toSorted()).toEqual([
      200, 410,
    ]);
    for (const response of responses) await response.body?.cancel();
  });

  it("rejects stale capability mutations after session replacement", async () => {
    const tableId = `stale-capability-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);

    const ownerFirst = await activateSession(stub, binding, owner.id, 1);
    expect(ownerFirst.status).toBe(200);
    await ownerFirst.body?.cancel();
    const invitationResponse = await post(
      stub,
      "/internal/invitations/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        invitedActorId: member.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(invitationResponse.status).toBe(200);
    const invitation = await invitationResponse.json<Capability>();

    const memberFirst = await activateSession(stub, binding, member.id, 1);
    expect(memberFirst.status).toBe(403);
    await memberFirst.body?.cancel();
    const ownerReplacement = await activateSession(stub, binding, owner.id, 2);
    expect(ownerReplacement.status).toBe(200);
    await ownerReplacement.body?.cancel();

    const staleCreate = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 1,
      },
    );
    expect(staleCreate.status).toBe(409);
    await expect(staleCreate.json()).resolves.toMatchObject({
      error: { code: "stale-session-generation" },
    });
    await expect(
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM capabilities",
            )
            .one().count,
      ),
    ).resolves.toBe(1);

    const memberReplacement = await activateSession(
      stub,
      binding,
      member.id,
      2,
    );
    expect(memberReplacement.status).toBe(403);
    await memberReplacement.body?.cancel();
    const staleRedeem = await post(stub, "/internal/invitations/redeem", {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 1,
    });
    expect(staleRedeem.status).toBe(409);
    await expect(staleRedeem.json()).resolves.toMatchObject({
      error: { code: "stale-session-generation" },
    });

    const currentRedeem = await post(stub, "/internal/invitations/redeem", {
      version: 1,
      ...authorization,
      actor: member,
      capability: invitation.capability,
      now: Date.now(),
      sessionGeneration: 2,
    });
    expect(currentRedeem.status).toBe(200);
    await currentRedeem.body?.cancel();
  });

  it("accepts a fresh session generation after resume resets the binding epoch", async () => {
    const tableId = `resume-session-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);
    for (const sessionGeneration of [1, 2, 3]) {
      const activation = await post(stub, "/internal/sessions/activate", {
        version: 1,
        ...authorization,
        actorId: owner.id,
        sessionGeneration,
      });
      expect(activation.status).toBe(200);
      await activation.body?.cancel();
    }
    const capabilityResponse = await post(
      stub,
      "/internal/resume-capabilities/create",
      {
        version: 1,
        ...authorization,
        actorId: owner.id,
        now: Date.now(),
        sessionGeneration: 3,
      },
    );
    const capability = await capabilityResponse.json<Capability>();
    const resumeResponse = await post(stub, "/internal/bindings/apply", {
      version: 1,
      operationId: crypto.randomUUID(),
      instanceId: "instance-new-session-epoch",
      actor: owner,
      deadlineAt: Date.now() + 60_000,
      intent: { kind: "resume", capability: capability.capability },
    });
    const resumed = await resumeResponse.json<Binding>();
    const freshActivation = await post(stub, "/internal/sessions/activate", {
      version: 1,
      ...bindingAuthorization(resumed, "instance-new-session-epoch"),
      actorId: owner.id,
      sessionGeneration: 1,
    });
    expect(freshActivation.status).toBe(200);
    await expect(freshActivation.json()).resolves.toEqual({
      version: 1,
      active: true,
      role: "owner",
    });
  });

  it("persists exclusive seats, ready state, and viewer-specific spectator roles", async () => {
    const tableId = `lobby-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();

    const ownerConnection = await openSocket(stub, binding, 1);
    expect(ownerConnection.initial).toMatchObject({
      stateVersion: 0,
      view: {
        spectators: [owner],
        viewer: { actor: owner, role: "spectator" },
      },
    });
    expect(Object.keys(ownerConnection.initial).sort()).toEqual([
      "protocolVersion",
      "stateVersion",
      "type",
      "view",
    ]);
    expect(Object.keys(ownerConnection.initial.view).sort()).toEqual([
      "phase",
      "seats",
      "spectators",
      "tableId",
      "viewer",
    ]);
    for (const seat of ownerConnection.initial.view.seats) {
      expect(Object.keys(seat).sort()).toEqual([
        "autopilot",
        "occupant",
        "ready",
        "seat",
      ]);
    }
    expect(JSON.stringify(ownerConnection.initial)).not.toMatch(
      /bindingProof|command|domainEvent|sessionGeneration|storage/u,
    );
    const attachment = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.getWebSockets()[0]?.deserializeAttachment() as unknown,
    );
    expect(attachment).toMatchObject({
      actorId: owner.id,
      version: 2,
    });
    if (typeof attachment !== "object" || attachment === null) {
      throw new Error("Expected a serialized socket attachment.");
    }
    expect(Object.keys(attachment).sort()).toEqual([
      "actorId",
      "connectionGeneration",
      "connectionId",
      "sessionExpiresAt",
      "version",
    ]);
    expect(JSON.stringify(attachment).length).toBeLessThan(512);
    const claimMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      ownerConnection.socket,
      2,
    );
    ownerConnection.socket.send(
      commandMessage("owner-east", 0, {
        type: "lobby/claim-seat",
        seat: "east",
      }),
    );
    const [claimReceipt, ownerPlayerView] = await claimMessages;
    expect(claimReceipt).toMatchObject({
      type: "table/receipt",
      commandId: "owner-east",
      outcome: "applied",
      stateVersion: 1,
    });
    expect(ownerPlayerView).toMatchObject({
      type: "table/snapshot",
      stateVersion: 1,
      view: { spectators: [], viewer: { role: "player", seat: "east" } },
    });

    const addedSnapshot = nextMessage(ownerConnection.socket);
    await addMember(stub, binding, member);
    expect(await addedSnapshot).toMatchObject({
      stateVersion: 2,
      view: { spectators: [member] },
    });
    const memberActivation = await activateSession(stub, binding, member.id, 1);
    expect(memberActivation.status).toBe(200);
    await memberActivation.body?.cancel();
    const memberConnection = await openSocket(stub, binding, 1, member);
    expect(memberConnection.initial).toMatchObject({
      stateVersion: 2,
      view: {
        seats: [
          { occupant: owner, ready: false, seat: "east" },
          { occupant: null, ready: false, seat: "south" },
          { occupant: null, ready: false, seat: "west" },
          { occupant: null, ready: false, seat: "north" },
        ],
        spectators: [member],
        viewer: { actor: member, role: "spectator" },
      },
    });

    const unavailable = await sendCommand(
      memberConnection.socket,
      "member-east",
      2,
      { type: "lobby/claim-seat", seat: "east" },
    );
    expect(unavailable).toMatchObject({
      outcome: "rejected",
      stateVersion: 2,
      error: { code: "seat-unavailable" },
    });
    const memberClaimMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      memberConnection.socket,
      2,
    );
    memberConnection.socket.send(
      commandMessage("member-south", 2, {
        type: "lobby/claim-seat",
        seat: "south",
      }),
    );
    const [memberClaimReceipt, memberPlayerView] = await memberClaimMessages;
    expect(memberClaimReceipt).toMatchObject({
      outcome: "applied",
      stateVersion: 3,
    });
    expect(memberPlayerView).toMatchObject({
      stateVersion: 3,
      view: { spectators: [], viewer: { role: "player", seat: "south" } },
    });

    const readyMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      memberConnection.socket,
      2,
    );
    memberConnection.socket.send(
      commandMessage("member-ready", 3, {
        type: "lobby/set-ready",
        ready: true,
      }),
    );
    const [readyReceipt, readyView] = await readyMessages;
    expect(readyReceipt).toMatchObject({ outcome: "applied", stateVersion: 4 });
    if (readyView?.type !== "table/snapshot") {
      throw new Error("Expected the ready-state snapshot.");
    }
    expect(readyView).toMatchObject({
      stateVersion: 4,
    });
    expect(readyView.view.seats).toContainEqual({
      autopilot: false,
      occupant: member,
      ready: true,
      seat: "south",
    });

    memberConnection.socket.close(1000, "reconnect test");
    await evictDurableObject(stub);
    const reconnected = await openSocket(stub, binding, 1, member);
    expect(reconnected.initial).toMatchObject({
      stateVersion: 4,
      view: {
        viewer: { role: "player", seat: "south" },
      },
    });
    expect(reconnected.initial.view.seats).toContainEqual({
      autopilot: false,
      occupant: member,
      ready: true,
      seat: "south",
    });
    const leaveMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      reconnected.socket,
      2,
    );
    reconnected.socket.send(
      commandMessage("member-leave", 4, { type: "lobby/leave-seat" }),
    );
    const [leaveReceipt, spectatorView] = await leaveMessages;
    expect(leaveReceipt).toMatchObject({ outcome: "applied", stateVersion: 5 });
    if (spectatorView?.type !== "table/snapshot") {
      throw new Error("Expected the post-leave snapshot.");
    }
    expect(spectatorView).toMatchObject({
      stateVersion: 5,
      view: {
        spectators: [member],
        viewer: { role: "spectator" },
      },
    });
    expect(spectatorView.view.seats).toContainEqual({
      autopilot: false,
      occupant: null,
      ready: false,
      seat: "south",
    });
    reconnected.socket.close(1000, "test complete");
    ownerConnection.socket.close(1000, "test complete");
  });

  it("fills all four seats while additional members remain spectators", async () => {
    const tableId = `full-lobby-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();

    const actors = [
      owner,
      { id: "discord:south", displayName: "South Player" },
      { id: "discord:west", displayName: "West Player" },
      { id: "discord:north", displayName: "North Player" },
      { id: "discord:fifth", displayName: "Fifth Member" },
    ] as const;
    for (const actor of actors.slice(1)) {
      await addMember(stub, binding, actor);
      const activation = await activateSession(stub, binding, actor.id, 1);
      expect(activation.status).toBe(200);
      await activation.body?.cancel();
    }

    const seats = ["east", "south", "west", "north"] as const;
    for (const [index, seat] of seats.entries()) {
      const actor = actors[index];
      if (actor === undefined) throw new Error("Missing test actor.");
      const connection = await openSocket(stub, binding, 1, actor);
      const expectedVersion = 4 + index;
      const messages = nextMessages<ReceiptMessage | SnapshotMessage>(
        connection.socket,
        2,
      );
      connection.socket.send(
        commandMessage(`claim-${seat}`, expectedVersion, {
          type: "lobby/claim-seat",
          seat,
        }),
      );
      const [receipt, snapshot] = await messages;
      expect(receipt).toMatchObject({
        outcome: "applied",
        stateVersion: expectedVersion + 1,
      });
      expect(snapshot).toMatchObject({
        stateVersion: expectedVersion + 1,
        view: { viewer: { actor, role: "player", seat } },
      });
      connection.socket.close(1000, "seat reserved");
    }

    await evictDurableObject(stub);
    const fifth = await openSocket(stub, binding, 1, actors[4]);
    expect(fifth.initial).toMatchObject({
      stateVersion: 8,
      view: {
        seats: seats.map((seat, index) => ({
          occupant: actors[index],
          ready: false,
          seat,
        })),
        spectators: [actors[4]],
        viewer: { actor: actors[4], role: "spectator" },
      },
    });
    fifth.socket.close(1000, "test complete");
  });

  it("persists a private draw/discard game and hash-linked events across eviction", async () => {
    const tableId = `game-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const actors = [
      owner,
      { id: "discord:game-south", displayName: "Game South" },
      { id: "discord:game-west", displayName: "Game West" },
      { id: "discord:game-north", displayName: "Game North" },
      { id: "discord:game-spectator", displayName: "Game Spectator" },
    ] as const;
    const actorById = new Map<string, (typeof actors)[number]>(
      actors.map((actor) => [actor.id, actor]),
    );
    for (const actor of actors) {
      if (actor !== owner) await addMember(stub, binding, actor);
      const activation = await activateSession(stub, binding, actor.id, 1);
      expect(activation.status).toBe(200);
      await activation.body?.cancel();
    }

    let version = 4;
    const seatNames = ["east", "south", "west", "north"] as const;
    for (const [index, seat] of seatNames.entries()) {
      const actor = actors[index];
      if (actor === undefined) throw new Error("Missing game actor.");
      const connection = await openSocket(stub, binding, 1, actor);
      const claimMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
        connection.socket,
        2,
      );
      connection.socket.send(
        commandMessage(`game-claim-${seat}`, version, {
          type: "lobby/claim-seat",
          seat,
        }),
      );
      expect((await claimMessages)[0]).toMatchObject({ outcome: "applied" });
      version += 1;
      const readyMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
        connection.socket,
        2,
      );
      connection.socket.send(
        commandMessage(`game-ready-${seat}`, version, {
          type: "lobby/set-ready",
          ready: true,
        }),
      );
      expect((await readyMessages)[0]).toMatchObject({ outcome: "applied" });
      version += 1;
      connection.socket.close(1000, "setup complete");
    }

    const starter = await openSocket(stub, binding, 1, owner);
    const startMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      starter.socket,
      2,
    );
    starter.socket.send(
      commandMessage("game-start", version, { type: "game/start" }),
    );
    const [startReceipt, startedSnapshot] = await startMessages;
    expect(startReceipt).toMatchObject({ outcome: "applied" });
    version += 1;
    expect(startedSnapshot).toMatchObject({
      stateVersion: version,
      view: { phase: "playing", game: { phase: "awaiting-dealer-discard" } },
    });
    expect(JSON.stringify(startedSnapshot)).not.toContain('"order"');
    const replayedStart = await sendCommand(
      starter.socket,
      "game-start",
      version - 1,
      { type: "game/start" },
    );
    expect(replayedStart).toEqual(startReceipt);
    const staleGameMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      starter.socket,
      2,
    );
    starter.socket.send(
      commandMessage("game-stale", version - 1, { type: "game/draw" }),
    );
    expect((await staleGameMessages)[0]).toMatchObject({
      outcome: "rejected",
      error: { code: "stale-state-version" },
    });
    starter.socket.close(1000, "start complete");

    const started = startedSnapshot as SnapshotMessage;
    const eastActorId = started.view.seats[0]?.occupant?.id;
    const eastActor =
      eastActorId === undefined ? undefined : actorById.get(eastActorId);
    if (eastActor === undefined) throw new Error("Missing selected dealer.");
    const east = await openSocket(stub, binding, 1, eastActor);
    const discardTile = east.initial.view.game?.viewerHand?.[0]?.id;
    if (discardTile === undefined)
      throw new Error("Dealer received no private hand.");
    const discardMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      east.socket,
      2,
    );
    east.socket.send(
      commandMessage("game-discard", version, {
        type: "game/discard",
        tileId: discardTile,
      }),
    );
    expect((await discardMessages)[0]).toMatchObject({ outcome: "applied" });
    version += 1;
    east.socket.close(1000, "discard complete");

    await evictDurableObject(stub);
    const southActorId = started.view.seats[1]?.occupant?.id;
    const southActor =
      southActorId === undefined ? undefined : actorById.get(southActorId);
    if (southActor === undefined) throw new Error("Missing South player.");
    let south = await openSocket(stub, binding, 1, southActor);
    expect(south.initial).toMatchObject({
      stateVersion: version,
      view: {
        phase: "playing",
        game: { phase: "awaiting-discard-reactions", turn: "south" },
      },
    });
    const windowId = south.initial.view.game?.reaction?.windowId;
    if (windowId === undefined) throw new Error("Discard opened no reaction.");
    const spectator = await openSocket(stub, binding, 1, actors[4]);
    const spectatorReactionView = spectator.initial;
    const westActorId = started.view.seats[2]?.occupant?.id;
    const westActor =
      westActorId === undefined ? undefined : actorById.get(westActorId);
    if (westActor === undefined) throw new Error("Missing West player.");
    const west = await openSocket(stub, binding, 1, westActor);
    const westReactionView = west.initial;
    for (const [index, seatIndex] of [1, 2, 3].entries()) {
      const responderId = started.view.seats[seatIndex]?.occupant?.id;
      const responder =
        responderId === undefined ? undefined : actorById.get(responderId);
      if (responder === undefined) throw new Error("Missing responder actor.");
      const connection =
        index === 0
          ? south
          : index === 1
            ? west
            : await openSocket(stub, binding, 1, responder);
      const messages = nextMessages<ReceiptMessage | SnapshotMessage>(
        connection.socket,
        2,
      );
      connection.socket.send(
        commandMessage(`game-pass-${String(index)}`, version, {
          type: "game/react",
          windowId,
          response: { type: "pass" },
        }),
      );
      const [receipt, snapshot] = await messages;
      expect(receipt).toMatchObject({ outcome: "applied" });
      if (index < 2) {
        expect(snapshot).toMatchObject({
          stateVersion: version,
          view: { game: { phase: "awaiting-discard-reactions" } },
        });
        const resynced = nextMessage(spectator.socket);
        spectator.socket.send(
          JSON.stringify({
            lastSeenStateVersion: version,
            protocolVersion: 2,
            type: "table/resync",
          }),
        );
        expect(await resynced).toEqual(spectatorReactionView);
        if (index === 0) {
          const opponentResync = nextMessage(west.socket);
          west.socket.send(
            JSON.stringify({
              lastSeenStateVersion: version,
              protocolVersion: 2,
              type: "table/resync",
            }),
          );
          expect(await opponentResync).toEqual(westReactionView);
          connection.socket.close(1000, "private intent persisted");
          await evictDurableObject(stub);
          south = await openSocket(stub, binding, 1, southActor);
          expect(south.initial).toMatchObject({
            stateVersion: version,
            view: {
              game: {
                viewerActions: {
                  reaction: { actions: [], status: "submitted" },
                },
              },
            },
          });
          const replayMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
            south.socket,
            2,
          );
          south.socket.send(
            commandMessage("game-pass-0", version, {
              type: "game/react",
              windowId,
              response: { type: "pass" },
            }),
          );
          const [replayedReceipt, replayedSnapshot] = await replayMessages;
          expect(replayedReceipt).toEqual(receipt);
          expect(replayedSnapshot).toMatchObject({
            stateVersion: version,
            view: {
              game: {
                viewerActions: {
                  reaction: { actions: [], status: "submitted" },
                },
              },
            },
          });
          const changedInput = await sendCommand(
            south.socket,
            "game-pass-0",
            version,
            {
              type: "game/react",
              windowId,
              response: { type: "win" },
            },
          );
          expect(changedInput).toMatchObject({
            outcome: "rejected",
            error: { code: "command-id-collision" },
          });
          const crossActor = await sendCommand(
            west.socket,
            "game-pass-0",
            version,
            {
              type: "game/react",
              windowId,
              response: { type: "pass" },
            },
          );
          expect(crossActor).toMatchObject({
            outcome: "rejected",
            error: { code: "command-id-collision" },
          });
          const finalResponse = await sendCommand(
            south.socket,
            "game-pass-final-response",
            version,
            {
              type: "game/react",
              windowId,
              response: { type: "pass" },
            },
          );
          expect(finalResponse).toMatchObject({
            outcome: "rejected",
            error: { code: "reaction-final" },
          });
        }
      } else {
        version += 1;
        expect(snapshot).toMatchObject({
          stateVersion: version,
          view: { game: { phase: "awaiting-draw", turn: "south" } },
        });
      }
      if (connection !== south) connection.socket.close(1000, "pass complete");
    }
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ event_json: string }>(
            "SELECT event_json FROM game_events ORDER BY sequence DESC LIMIT 4",
          )
          .toArray()
          .reverse()
          .map(
            ({ event_json }) =>
              (JSON.parse(event_json) as { readonly type: string }).type,
          ),
      ),
    ).resolves.toEqual([
      "game/reaction-intent-submitted",
      "game/reaction-intent-submitted",
      "game/reaction-intent-submitted",
      "game/reaction-resolved",
    ]);
    const staleWindow = await sendCommand(
      south.socket,
      "game-stale-window",
      version,
      {
        type: "game/react",
        windowId,
        response: { type: "pass" },
      },
    );
    expect(staleWindow).toMatchObject({
      outcome: "rejected",
      error: { code: "stale-reaction-window" },
      stateVersion: version,
    });
    const drawMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      south.socket,
      2,
    );
    south.socket.send(
      commandMessage("game-draw", version, { type: "game/draw" }),
    );
    const [drawReceipt, drawnSnapshot] = await drawMessages;
    expect(drawReceipt).toMatchObject({ outcome: "applied" });
    expect(drawnSnapshot).toMatchObject({
      view: { game: { phase: "awaiting-discard", turn: "south" } },
    });
    expect(
      (drawnSnapshot as SnapshotMessage).view.game?.viewerHand,
    ).toHaveLength(14);

    expect(spectator.initial.view.game).not.toHaveProperty("viewerHand");
    expect(JSON.stringify(spectator.initial)).not.toContain('"hand"');
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        events: state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM game_events")
          .one().count,
        hashesValid: state.storage.sql
          .exec<{ event_hash: string }>(
            "SELECT event_hash FROM game_events ORDER BY sequence",
          )
          .toArray()
          .every(({ event_hash }) => /^[0-9a-f]{64}$/u.test(event_hash)),
        schemaVersion: state.storage.sql
          .exec<{ schema_version: number }>(
            "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
          )
          .one().schema_version,
      })),
    ).resolves.toMatchObject({
      events: 7,
      hashesValid: true,
      schemaVersion: 4,
    });
    spectator.socket.close(1000, "test complete");
    south.socket.close(1000, "test complete");
  });

  it.each([
    {
      kind: "chow" as const,
      claimant: "south" as const,
      handTileIds: [0, 8],
      expectedTileIds: [0, 4, 8],
    },
    {
      kind: "pung" as const,
      claimant: "west" as const,
      handTileIds: [5, 6],
      expectedTileIds: [4, 5, 6],
    },
    {
      kind: "kong" as const,
      claimant: "west" as const,
      handTileIds: [5, 6, 7],
      expectedTileIds: [4, 5, 6, 7],
    },
  ])("resolves a scored $kind claim through TableRoom", async (claim) => {
    const tableId = `claim-${claim.kind}-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const actors = {
      east: owner,
      south: { id: `${tableId}:south`, displayName: "Claim South" },
      west: { id: `${tableId}:west`, displayName: "Claim West" },
      north: { id: `${tableId}:north`, displayName: "Claim North" },
    } as const;
    const started = startHongKongV2Game(
      {
        east: actors.east.id,
        south: actors.south.id,
        west: actors.west.id,
        north: actors.north.id,
      },
      Uint8Array.from(
        { length: 1_028 },
        (_, index) => (index * 73 + 202) & 0xff,
      ),
    );
    const placed = placePhysicalTiles(started.state, [
      { index: 0, seat: "east", tileId: 4 },
      { index: 0, seat: "south", tileId: 0 },
      { index: 1, seat: "south", tileId: 8 },
      { index: 0, seat: "west", tileId: 5 },
      { index: 1, seat: "west", tileId: 6 },
      { index: 2, seat: "west", tileId: 7 },
    ]);
    const genesis = { ...started.event, state: placed };
    const discarded = applyGameCommandV2(placed, placed.players.east.actorId, {
      type: "game/discard",
      tileId: 4 as PhysicalTileId,
    });
    if (!discarded.accepted || discarded.state === undefined) {
      throw new Error(
        `Claim fixture discard failed: ${JSON.stringify(discarded)}`,
      );
    }
    const window = discarded.state.reactionWindow;
    if (window === null) throw new Error("Claim fixture opened no window.");
    const version = await installTableGameFixture(stub, binding, actors, [
      genesis,
      ...discarded.events,
    ]);
    const connections = new Map<
      GameSeatName,
      Awaited<ReturnType<typeof openSocket>>
    >();
    const actorById = new Map<
      string,
      { readonly displayName: string; readonly id: string }
    >(Object.values(actors).map((actor) => [actor.id, actor]));
    for (const currentSeat of window.responderOrder) {
      const seat = String(currentSeat) as GameSeatName;
      const actor = actorById.get(discarded.state.players[seat].actorId);
      if (actor === undefined) throw new Error("Missing rotated claim actor.");
      connections.set(seat, await openSocket(stub, binding, 1, actor));
    }
    const responseOrder = [
      claim.claimant,
      ...window.responderOrder
        .map((seat) => String(seat) as GameSeatName)
        .filter((seat) => seat !== claim.claimant),
    ];
    let finalSnapshot: SnapshotMessage | undefined;
    for (const [index, seat] of responseOrder.entries()) {
      const connection = connections.get(seat);
      if (connection === undefined) throw new Error("Missing claim responder.");
      const messages = nextMessages<ReceiptMessage | SnapshotMessage>(
        connection.socket,
        2,
      );
      connection.socket.send(
        commandMessage(`claim-${claim.kind}-${seat}`, version, {
          type: "game/react",
          windowId: window.id,
          response:
            seat === claim.claimant
              ? { type: claim.kind, handTileIds: claim.handTileIds }
              : { type: "pass" },
        }),
      );
      const [receipt, snapshot] = await messages;
      expect(receipt).toMatchObject({
        outcome: "applied",
        stateVersion: index === 2 ? version + 1 : version,
      });
      if (index === 2) finalSnapshot = snapshot as SnapshotMessage;
    }
    const publicMeld = finalSnapshot?.view.game?.players?.find(
      ({ seat }) => seat === claim.claimant,
    )?.melds?.[0];
    expect(finalSnapshot).toMatchObject({
      stateVersion: version + 1,
      view: {
        game: { phase: "awaiting-discard", turn: claim.claimant },
      },
    });
    expect(publicMeld).toMatchObject({
      claimedTileId: 4,
      exposure: "exposed",
      kind: claim.kind,
      sourceSeat: "east",
      ...(claim.kind === "kong" ? { kongKind: "exposed" } : {}),
    });
    expect(publicMeld?.tileIds.map(({ id }) => id)).toEqual(
      claim.expectedTileIds,
    );
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        const checkpoint = decodeCanonicalVersionedGameJson(
          state.storage.sql
            .exec<{ state_json: string }>(
              "SELECT state_json FROM canonical_game_state WHERE singleton = 1",
            )
            .one().state_json,
        );
        if (checkpoint.schemaVersion !== 2) {
          throw new Error("Claim checkpoint regressed.");
        }
        return checkpoint.players[claim.claimant].melds[0]?.tileIds;
      }),
    ).resolves.toEqual(claim.expectedTileIds);
    for (const connection of connections.values()) {
      connection.socket.close(1000, "test complete");
    }
  });

  it("persists and projects a scored self-win completion atomically", async () => {
    const tableId = `scored-win-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const actors = {
      east: owner,
      south: { id: `${tableId}:south`, displayName: "Win South" },
      west: { id: `${tableId}:west`, displayName: "Win West" },
      north: { id: `${tableId}:north`, displayName: "Win North" },
    } as const;
    const started = startHongKongV2Game(
      {
        east: actors.east.id,
        south: actors.south.id,
        west: actors.west.id,
        north: actors.north.id,
      },
      Uint8Array.from(
        { length: 1_028 },
        (_, index) => (index * 73 + 209) & 0xff,
      ),
    );
    const winningIds = [0, 1, 2, 4, 5, 6, 8, 9, 10, 124, 125, 126, 108, 109];
    const placed = placePhysicalTiles(
      started.state,
      winningIds.map((tileId, index) => ({
        index,
        seat: "east" as const,
        tileId,
      })),
    );
    const version = await installTableGameFixture(stub, binding, actors, [
      { ...started.event, state: placed },
    ]);
    const actorById = new Map<
      string,
      { readonly displayName: string; readonly id: string }
    >(Object.values(actors).map((actor) => [actor.id, actor]));
    const eastActor = actorById.get(placed.players.east.actorId);
    if (eastActor === undefined) throw new Error("Missing rotated winner.");
    const east = await openSocket(stub, binding, 1, eastActor);
    expect(east.initial.view.game?.viewerActions?.self).toContainEqual({
      type: "game/declare-win",
    });
    const messages = nextMessages<ReceiptMessage | SnapshotMessage>(
      east.socket,
      2,
    );
    east.socket.send(
      commandMessage("scored-self-win", version, {
        type: "game/declare-win",
      }),
    );
    const [receipt, snapshot] = await messages;
    expect(receipt).toMatchObject({
      outcome: "applied",
      stateVersion: version + 1,
    });
    expect(snapshot).toMatchObject({
      stateVersion: version + 1,
      view: {
        phase: "complete",
        game: {
          phase: "complete",
          result: {
            cappedFaan: 13,
            isLegalWin: true,
            source: { type: "self-pick" },
            winnerSeat: "east",
          },
        },
      },
    });
    expect(
      (snapshot as SnapshotMessage).view.game?.result?.awardedPatterns,
    ).toContainEqual(expect.objectContaining({ id: "heavenly-hand" }));
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        eventTypes: state.storage.sql
          .exec<{ event_json: string }>(
            "SELECT event_json FROM game_events ORDER BY sequence DESC LIMIT 2",
          )
          .toArray()
          .reverse()
          .map(
            ({ event_json }) =>
              (JSON.parse(event_json) as { readonly type: string }).type,
          ),
        gameplayDeadlines: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM deadlines WHERE status = 'pending' AND kind IN ('reaction', 'turn')",
          )
          .one().count,
      })),
    ).resolves.toEqual({
      eventTypes: ["game/self-win-declared", "game/hand-completed"],
      gameplayDeadlines: 0,
    });
    east.socket.close(1000, "test complete");
  });

  it.each(["some", "all"] as const)(
    "immediately passes %s automated responders in a newly opened discard window",
    async (coverage) => {
      const tableId = `autopilot-reaction-${coverage}-${crypto.randomUUID()}`;
      const stub = tableRoom(tableId);
      const { binding } = await createTable(stub, tableId);
      const actors = {
        east: owner,
        south: { id: `${tableId}:south`, displayName: "Auto South" },
        west: { id: `${tableId}:west`, displayName: "Auto West" },
        north: { id: `${tableId}:north`, displayName: "Auto North" },
      } as const;
      const started = startHongKongV2Game(
        {
          east: actors.east.id,
          south: actors.south.id,
          west: actors.west.id,
          north: actors.north.id,
        },
        Uint8Array.from(
          { length: 1_028 },
          (_, index) => (index * 73 + 221) & 0xff,
        ),
      );
      const version = await installTableGameFixture(stub, binding, actors, [
        started.event,
      ]);
      const actorById = new Map<
        string,
        { readonly displayName: string; readonly id: string }
      >(Object.values(actors).map((actor) => [actor.id, actor]));
      const dealer = actorById.get(started.state.players.east.actorId);
      if (dealer === undefined) throw new Error("Missing automatic dealer.");
      const connection = await openSocket(stub, binding, 1, dealer);
      const responderActors = [
        started.state.players.south.actorId,
        started.state.players.west.actorId,
        started.state.players.north.actorId,
      ];
      const automated =
        coverage === "all" ? responderActors : responderActors.slice(0, 1);
      const tileId = connection.initial.view.game?.viewerHand?.[0]?.id;
      if (tileId === undefined)
        throw new Error("Automatic dealer has no tile.");
      const messages = nextMessages<ReceiptMessage | SnapshotMessage>(
        connection.socket,
        2,
      );
      const message = commandMessage(`automatic-window-${coverage}`, version, {
        type: "game/discard",
        tileId,
      });
      await runInDurableObject(stub, async (instance, state) => {
        for (const actorId of automated) {
          const updated = state.storage.sql.exec(
            "UPDATE player_automation SET autopilot = 1 WHERE actor_id = ?",
            actorId,
          );
          if (updated.rowsWritten !== 1) {
            throw new Error("Automatic responder fixture is missing.");
          }
        }
        const serverSocket = state.getWebSockets()[0];
        if (serverSocket === undefined) {
          throw new Error("Automatic reaction fixture has no server socket.");
        }
        await instance.webSocketMessage(serverSocket, message);
      });
      expect((await messages)[0]).toMatchObject({
        outcome: "applied",
        stateVersion: version + 1,
      });
      await expect(
        runInDurableObject(stub, (_instance, state) => {
          const checkpoint = decodeCanonicalVersionedGameJson(
            state.storage.sql
              .exec<{ state_json: string }>(
                "SELECT state_json FROM canonical_game_state WHERE singleton = 1",
              )
              .one().state_json,
          );
          if (checkpoint.schemaVersion !== 2) {
            throw new Error("Automatic reaction checkpoint regressed.");
          }
          return {
            intents:
              checkpoint.reactionWindow === null
                ? 3
                : Object.keys(checkpoint.reactionWindow.intents).length,
            phase: checkpoint.phase,
            reactionDeadlines: state.storage.sql
              .exec<{ count: number }>(
                "SELECT count(*) AS count FROM deadlines WHERE kind = 'reaction' AND status = 'pending'",
              )
              .one().count,
          };
        }),
      ).resolves.toEqual(
        coverage === "all"
          ? {
              intents: 3,
              phase: "awaiting-draw",
              reactionDeadlines: 0,
            }
          : {
              intents: 1,
              phase: "awaiting-discard-reactions",
              reactionDeadlines: 1,
            },
      );
      connection.socket.close(1000, "test complete");
    },
  );

  it("immediately passes automated responders in a new added-kong window", async () => {
    const tableId = `autopilot-added-kong-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const actors = {
      east: owner,
      south: { id: `${tableId}:south`, displayName: "Kong South" },
      west: { id: `${tableId}:west`, displayName: "Kong West" },
      north: { id: `${tableId}:north`, displayName: "Kong North" },
    } as const;
    const started = startHongKongV2Game(
      {
        east: actors.east.id,
        south: actors.south.id,
        west: actors.west.id,
        north: actors.north.id,
      },
      Uint8Array.from(
        { length: 1_028 },
        (_, index) => (index * 73 + 207) & 0xff,
      ),
    );
    let current = placePhysicalTiles(started.state, [
      { index: 0, seat: "east", tileId: 4 },
      { index: 0, seat: "south", tileId: 5 },
      { index: 1, seat: "south", tileId: 6 },
      { index: 2, seat: "south", tileId: 7 },
    ]);
    const events: VersionedHongKongGameEvent[] = [
      { ...started.event, state: current },
    ];
    const apply = (
      actorId: string,
      command: Parameters<typeof applyGameCommandV2>[2],
    ) => {
      const decision = applyGameCommandV2(current, actorId, command);
      if (!decision.accepted || decision.state === undefined) {
        throw new Error("Added-kong fixture command failed.");
      }
      events.push(...decision.events);
      current = decision.state;
    };
    apply(current.players.east.actorId, {
      type: "game/discard",
      tileId: 4 as PhysicalTileId,
    });
    const firstWindow = current.reactionWindow;
    if (firstWindow === null) throw new Error("Pung fixture opened no window.");
    apply(current.players.south.actorId, {
      type: "game/react",
      response: {
        type: "pung",
        handTileIds: [5 as PhysicalTileId, 6 as PhysicalTileId],
      },
      windowId: firstWindow.id,
    });
    for (const seat of ["west", "north"] as const) {
      apply(current.players[seat].actorId, {
        type: "game/react",
        response: { type: "pass" },
        windowId: firstWindow.id,
      });
    }
    const meldId = current.players.south.melds[0]?.id;
    if (meldId === undefined) throw new Error("Pung fixture has no meld.");
    const firstEvent = events[0];
    if (firstEvent === undefined)
      throw new Error("Kong fixture has no genesis.");
    const version = await installTableGameFixture(stub, binding, actors, [
      firstEvent,
      ...events.slice(1),
    ]);
    const actorById = new Map<
      string,
      { readonly displayName: string; readonly id: string }
    >(Object.values(actors).map((actor) => [actor.id, actor]));
    const sourceActor = actorById.get(current.players.south.actorId);
    if (sourceActor === undefined)
      throw new Error("Missing kong source actor.");
    const source = await openSocket(stub, binding, 1, sourceActor);
    await runInDurableObject(stub, (_instance, state) => {
      for (const seat of ["east", "west", "north"] as const) {
        state.storage.sql.exec(
          "UPDATE player_automation SET autopilot = 1 WHERE actor_id = ?",
          current.players[seat].actorId,
        );
      }
    });
    const messages = nextMessages<ReceiptMessage | SnapshotMessage>(
      source.socket,
      2,
    );
    source.socket.send(
      commandMessage("automatic-added-kong-window", version, {
        type: "game/propose-added-kong",
        meldId,
        tileId: 7,
      }),
    );
    expect((await messages)[0]).toMatchObject({
      outcome: "applied",
      stateVersion: version + 1,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        const checkpoint = decodeCanonicalVersionedGameJson(
          state.storage.sql
            .exec<{ state_json: string }>(
              "SELECT state_json FROM canonical_game_state WHERE singleton = 1",
            )
            .one().state_json,
        );
        if (checkpoint.schemaVersion !== 2) {
          throw new Error("Added-kong checkpoint regressed.");
        }
        return {
          meld: checkpoint.players.south.melds[0],
          phase: checkpoint.phase,
          reactionWindow: checkpoint.reactionWindow,
          tailTypes: state.storage.sql
            .exec<{ event_json: string }>(
              "SELECT event_json FROM game_events ORDER BY sequence DESC LIMIT 6",
            )
            .toArray()
            .reverse()
            .map(
              ({ event_json }) =>
                (JSON.parse(event_json) as { readonly type: string }).type,
            ),
        };
      }),
    ).resolves.toMatchObject({
      meld: { kind: "kong", kongKind: "added", tileIds: [4, 5, 6, 7] },
      phase: "awaiting-discard",
      reactionWindow: null,
      tailTypes: [
        "game/added-kong-proposed",
        "game/reaction-intent-submitted",
        "game/reaction-intent-submitted",
        "game/reaction-intent-submitted",
        "game/reaction-resolved",
        "game/kong-replacement-drawn",
      ],
    });
    source.socket.close(1000, "test complete");
  });

  it("stores actor-scoped receipts and handles replay, collision, and stale state safely", async () => {
    const tableId = `receipt-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const activation = await activateSession(stub, binding, owner.id, 1);
    expect(activation.status).toBe(200);
    await activation.body?.cancel();
    const { socket } = await openSocket(stub, binding, 1);

    const appliedMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      socket,
      2,
    );
    const request = commandMessage("stable-command", 0, {
      type: "lobby/claim-seat",
      seat: "west",
    });
    socket.send(request);
    const [applied] = await appliedMessages;
    expect(applied).toMatchObject({ outcome: "applied", stateVersion: 1 });

    await evictDurableObject(stub);
    const replay = nextMessage<ReceiptMessage>(socket);
    socket.send(request);
    expect(await replay).toEqual(applied);

    const collision = await sendCommand(socket, "stable-command", 1, {
      type: "lobby/leave-seat",
    });
    expect(collision).toMatchObject({
      outcome: "rejected",
      error: {
        code: "command-id-collision",
        message: "The command identifier was already used.",
      },
    });
    expect(JSON.stringify(collision)).not.toContain("west");

    const staleMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      socket,
      2,
    );
    socket.send(
      commandMessage("stale-command", 0, {
        type: "lobby/set-ready",
        ready: true,
      }),
    );
    const [stale, fresh] = await staleMessages;
    expect(stale).toMatchObject({
      type: "table/receipt",
      outcome: "rejected",
      stateVersion: 1,
      error: { code: "stale-state-version" },
    });
    expect(fresh).toMatchObject({ type: "table/snapshot", stateVersion: 1 });

    await addMember(stub, binding, member);
    const memberActivation = await activateSession(stub, binding, member.id, 1);
    expect(memberActivation.status).toBe(200);
    await memberActivation.body?.cancel();
    const memberConnection = await openSocket(stub, binding, 1, member);
    const crossActorCollision = await sendCommand(
      memberConnection.socket,
      "stable-command",
      2,
      { type: "lobby/claim-seat", seat: "north" },
    );
    expect(crossActorCollision).toMatchObject({
      outcome: "rejected",
      stateVersion: 2,
      error: {
        code: "command-id-collision",
        message: "The command identifier was already used.",
      },
    });
    expect(JSON.stringify(crossActorCollision)).not.toContain(owner.id);

    await expect(
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM lobby_command_receipts",
            )
            .one().count,
      ),
    ).resolves.toBe(2);
    memberConnection.socket.close(1000, "test complete");
    socket.close(1000, "test complete");
  });

  it("applies one actor's simultaneous duplicate command only once", async () => {
    const tableId = `duplicate-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const activation = await activateSession(stub, binding, owner.id, 1);
    expect(activation.status).toBe(200);
    await activation.body?.cancel();
    const first = await openSocket(stub, binding, 1);
    const second = await openSocket(stub, binding, 1);
    const firstReceipt = nextReceipt(first.socket);
    const secondReceipt = nextReceipt(second.socket);
    const duplicate = commandMessage("same-actor-duplicate", 0, {
      type: "lobby/claim-seat",
      seat: "north",
    });

    first.socket.send(duplicate);
    second.socket.send(duplicate);

    await expect(firstReceipt).resolves.toMatchObject({
      outcome: "applied",
      stateVersion: 1,
    });
    await expect(secondReceipt).resolves.toMatchObject({
      outcome: "applied",
      stateVersion: 1,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        receipts: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM lobby_command_receipts",
          )
          .one().count,
        seats: state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM lobby_seats")
          .one().count,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      })),
    ).resolves.toEqual({ receipts: 1, seats: 1, stateVersion: 1 });
    first.socket.close(1000, "test complete");
    second.socket.close(1000, "test complete");
  });

  it("migrates persisted v1 storage to v4 without losing milestone 2 data", async () => {
    const tableId = `migration-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const binding: Binding = {
      bindingGeneration: 3,
      bindingProof: "B".repeat(43),
      role: "owner",
      tableId,
      version: 1,
    };
    await runInDurableObject(stub, (_instance, state) => {
      for (const table of [
        "system_command_receipts",
        "deadlines",
        "player_automation",
        "room_lifecycle",
        "game_events",
        "canonical_game_state",
        "lobby_command_receipts",
        "lobby_seats",
        "lobby_state",
        "connection_grants",
        "actor_sessions",
        "capabilities",
        "binding_receipts",
        "members",
        "table_record",
        "storage_metadata",
      ]) {
        state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      for (const statement of tableRoomV1Schema) {
        state.storage.sql.exec(statement);
      }
      state.storage.sql.exec(
        "INSERT INTO storage_metadata (singleton, schema_version) VALUES (1, 1)",
      );
      state.storage.sql.exec(
        "INSERT INTO table_record (singleton, table_id, owner_actor_id, created_at, instance_id, binding_generation, binding_proof, binding_operation_id) VALUES (1, ?, ?, 100, 'instance-original', ?, ?, 'fixture-binding')",
        tableId,
        owner.id,
        binding.bindingGeneration,
        binding.bindingProof,
      );
      state.storage.sql.exec(
        "INSERT INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'owner', 100), (?, ?, 'member', 101)",
        owner.id,
        owner.displayName,
        member.id,
        member.displayName,
      );
      state.storage.sql.exec(
        "INSERT INTO binding_receipts (operation_id, request_json, status, response_json, http_status, created_at, updated_at) VALUES ('fixture-binding', '{}', 'applied', '{}', 200, 100, 100)",
      );
      state.storage.sql.exec(
        "INSERT INTO capabilities (capability_id, kind, subject_actor_id, secret_hash, expected_binding_generation, expires_at, consumed_actor_id, consumed_operation_id) VALUES (?, 'resume', ?, ?, 3, 9999999999999, NULL, NULL)",
        "C".repeat(22),
        owner.id,
        "S".repeat(43),
      );
      state.storage.sql.exec(
        "INSERT INTO actor_sessions (actor_id, session_generation, activated_at) VALUES (?, 7, 100)",
        owner.id,
      );
      state.storage.sql.exec(
        "INSERT INTO connection_grants (connection_generation, actor_id, display_name, instance_id, table_id, binding_generation, binding_proof, session_generation, expires_at) VALUES ('fixture-connection', ?, ?, 'instance-original', ?, 3, ?, 7, 9999999999999)",
        owner.id,
        owner.displayName,
        tableId,
        binding.bindingProof,
      );
    });
    await evictDurableObject(stub);

    const migratedActivation = await activateSession(
      stub,
      binding,
      owner.id,
      7,
    );
    expect(migratedActivation.status).toBe(200);
    await migratedActivation.body?.cancel();
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        actorSession: state.storage.sql
          .exec<{ session_generation: number }>(
            "SELECT session_generation FROM actor_sessions WHERE actor_id = ?",
            owner.id,
          )
          .one().session_generation,
        bindingReceipts: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM binding_receipts",
          )
          .one().count,
        capabilities: state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM capabilities")
          .one().count,
        connectionGrant: state.storage.sql
          .exec<{ connection_generation: string }>(
            "SELECT connection_generation FROM connection_grants",
          )
          .one().connection_generation,
        members: state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM members")
          .one().count,
        schemaVersion: state.storage.sql
          .exec<{ schema_version: number }>(
            "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
          )
          .one().schema_version,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
        tables: state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM table_record")
          .one().count,
      })),
    ).resolves.toEqual({
      actorSession: 7,
      bindingReceipts: 1,
      capabilities: 1,
      connectionGrant: "fixture-connection",
      members: 2,
      schemaVersion: 4,
      stateVersion: 0,
      tables: 1,
    });
  });

  it("migrates schema v2 lobby state to v4 authority storage", async () => {
    const tableId = `migration-v2-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const activation = await activateSession(stub, binding, owner.id, 1);
    expect(activation.status).toBe(200);
    await activation.body?.cancel();
    const connection = await openSocket(stub, binding, 1);
    const messages = nextMessages<ReceiptMessage | SnapshotMessage>(
      connection.socket,
      2,
    );
    connection.socket.send(
      commandMessage("migration-v2-seat", 0, {
        type: "lobby/claim-seat",
        seat: "east",
      }),
    );
    await messages;
    connection.socket.close(1000, "downgrade fixture");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE system_command_receipts");
      state.storage.sql.exec("DROP TABLE deadlines");
      state.storage.sql.exec("DROP TABLE player_automation");
      state.storage.sql.exec("DROP TABLE room_lifecycle");
      state.storage.sql.exec("DROP TABLE game_events");
      state.storage.sql.exec("DROP TABLE canonical_game_state");
      state.storage.sql.exec(
        "UPDATE storage_metadata SET schema_version = 2 WHERE singleton = 1",
      );
    });
    await evictDurableObject(stub);
    const migrated = await openSocket(stub, binding, 1);
    expect(migrated.initial).toMatchObject({
      stateVersion: 1,
      view: { phase: "lobby" },
    });
    expect(migrated.initial.view.seats[0]).toEqual({
      autopilot: false,
      seat: "east",
      occupant: owner,
      ready: false,
    });
    await expect(
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ schema_version: number }>(
              "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
            )
            .one().schema_version,
      ),
    ).resolves.toBe(4);
    migrated.socket.close(1000, "test complete");
  });

  it("reconciles an active v3 game after eviction and continues play", async () => {
    const tableId = `migration-v3-active-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();
    const players = {
      east: owner,
      south: { id: "discord:v3-south", displayName: "V3 South" },
      west: { id: "discord:v3-west", displayName: "V3 West" },
      north: { id: "discord:v3-north", displayName: "V3 North" },
    } as const;
    for (const actor of [players.south, players.west, players.north]) {
      await addMember(stub, binding, actor);
    }
    const started = startHongKongV2Game(
      {
        east: players.east.id,
        south: players.south.id,
        west: players.west.id,
        north: players.north.id,
      },
      Uint8Array.from(
        { length: 1_028 },
        (_, index) => (index * 47 + 23) & 0xff,
      ),
    );
    const prepared = await prepareGameEventBatch(undefined, [started.event]);
    await runInDurableObject(stub, (_instance, state) => {
      persistPreparedGameBatch(state.storage, prepared, (sql) => {
        for (const [seat, actor] of Object.entries(players)) {
          sql.exec(
            "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES (?, ?, ?, 1)",
            seat,
            actor.id,
            actor.displayName,
          );
        }
      });
      state.storage.sql.exec("DROP TABLE system_command_receipts");
      state.storage.sql.exec("DROP TABLE deadlines");
      state.storage.sql.exec("DROP TABLE player_automation");
      state.storage.sql.exec("DROP TABLE room_lifecycle");
      state.storage.sql.exec(
        "UPDATE storage_metadata SET schema_version = 3 WHERE singleton = 1",
      );
    });
    await evictDurableObject(stub);

    const activation = await activateSession(stub, binding, owner.id, 1);
    expect(activation.status).toBe(200);
    await activation.body?.cancel();
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        alarmScheduled: (await state.storage.getAlarm()) !== null,
        automations: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM player_automation",
          )
          .one().count,
        pendingKinds: state.storage.sql
          .exec<{ kind: string }>(
            "SELECT kind FROM deadlines WHERE status = 'pending' ORDER BY kind, deadline_id",
          )
          .toArray()
          .map(({ kind }) => kind),
        schemaVersion: state.storage.sql
          .exec<{ schema_version: number }>(
            "SELECT schema_version FROM storage_metadata WHERE singleton = 1",
          )
          .one().schema_version,
      })),
    ).resolves.toMatchObject({
      alarmScheduled: true,
      automations: 4,
      pendingKinds: [
        "abandonment",
        "disconnect",
        "disconnect",
        "disconnect",
        "disconnect",
      ],
      schemaVersion: 4,
    });

    const playerById = new Map<
      string,
      { readonly displayName: string; readonly id: string }
    >(Object.values(players).map((actor) => [actor.id, actor]));
    const dealer = playerById.get(started.state.players.east.actorId);
    if (dealer === undefined) throw new Error("Missing migrated dealer.");
    const connection = await openSocket(stub, binding, 1, dealer);
    expect(connection.initial).toMatchObject({
      stateVersion: 3,
      view: {
        game: { phase: "awaiting-dealer-discard", turn: "east" },
        phase: "playing",
      },
    });
    const tileId = connection.initial.view.game?.viewerHand?.[0]?.id;
    if (tileId === undefined) throw new Error("Migrated dealer has no tile.");
    const messages = nextMessages<ReceiptMessage | SnapshotMessage>(
      connection.socket,
      2,
    );
    connection.socket.send(
      commandMessage("v3-continued-discard", 3, {
        type: "game/discard",
        tileId,
      }),
    );
    expect((await messages)[0]).toMatchObject({
      outcome: "applied",
      stateVersion: 4,
    });
    await expect(
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM deadlines WHERE kind = 'reaction' AND status = 'pending'",
            )
            .one().count,
      ),
    ).resolves.toBe(1);
    connection.socket.close(1000, "test complete");
  });

  it("resolves a persisted reaction deadline once and makes duplicate alarms no-ops", async () => {
    const tableId = `reaction-alarm-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    await createTable(stub, tableId);
    const started = startHongKongV2Game(
      {
        east: "alarm:east",
        south: "alarm:south",
        west: "alarm:west",
        north: "alarm:north",
      },
      Uint8Array.from(
        { length: 1_028 },
        (_, index) => (index * 37 + 11) & 0xff,
      ),
    );
    const tileId = started.state.players.east.hand[0];
    if (tileId === undefined) throw new Error("Alarm dealer has no tile.");
    const discarded = applyGameCommandV2(
      started.state,
      started.state.players.east.actorId,
      { type: "game/discard", tileId },
    );
    if (!discarded.accepted || discarded.state === undefined) {
      throw new Error("Alarm fixture discard failed.");
    }
    const window = discarded.state.reactionWindow;
    if (window === null) throw new Error("Alarm fixture has no reaction.");
    const prepared = await prepareGameEventBatch(undefined, [
      started.event,
      ...discarded.events,
    ]);
    const futureDueAt = Date.now() + 60_000;
    await runInDurableObject(stub, (_instance, state) => {
      persistPreparedGameBatch(state.storage, prepared, (sql) => {
        scheduleDeadline(sql, {
          deadlineId: `reaction:${String(window.openingSequence)}`,
          dueAt: futureDueAt,
          kind: "reaction",
          payload: {
            type: "system/reaction-expired",
            openingSequence: window.openingSequence,
            windowId: window.id,
          },
          status: "pending",
          targetGeneration: window.openingSequence,
        });
      });
    });

    await runInDurableObject(stub, (instance) => instance.alarm());
    await expect(
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM system_command_receipts",
            )
            .one().count,
      ),
    ).resolves.toBe(0);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE deadlines SET due_at = ? WHERE deadline_id = ?",
        Date.now() - 1,
        `reaction:${String(window.openingSequence)}`,
      );
    });
    await runInDurableObject(stub, (instance) => instance.alarm());
    await runInDurableObject(stub, (instance) => instance.alarm());
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        const checkpoint = state.storage.sql
          .exec<{ state_json: string }>(
            "SELECT state_json FROM canonical_game_state WHERE singleton = 1",
          )
          .one();
        return {
          eventTypes: state.storage.sql
            .exec<{ event_json: string }>(
              "SELECT event_json FROM game_events ORDER BY sequence",
            )
            .toArray()
            .map(
              ({ event_json }) =>
                (JSON.parse(event_json) as { readonly type: string }).type,
            ),
          phase: decodeCanonicalVersionedGameJson(checkpoint.state_json).phase,
          receipts: state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM system_command_receipts",
            )
            .one().count,
          stateVersion: state.storage.sql
            .exec<{ state_version: number }>(
              "SELECT state_version FROM lobby_state WHERE singleton = 1",
            )
            .one().state_version,
        };
      }),
    ).resolves.toEqual({
      eventTypes: [
        "game/started",
        "game/discard-reaction-opened",
        "game/reaction-resolved",
      ],
      phase: "awaiting-draw",
      receipts: 1,
      stateVersion: 1,
    });
  });

  it.each(["disconnect", "turn"] as const)(
    "performs deterministic draw and discard for an in-game %s deadline without choosing win or kong",
    async (kind) => {
      const tableId = `automatic-${kind}-${crypto.randomUUID()}`;
      const stub = tableRoom(tableId);
      await createTable(stub, tableId);
      const started = startHongKongV2Game(
        {
          east: `${kind}:east`,
          south: `${kind}:south`,
          west: `${kind}:west`,
          north: `${kind}:north`,
        },
        Uint8Array.from(
          { length: 1_028 },
          (_, index) => (index * 53 + 17) & 0xff,
        ),
      );
      const openingTile = started.state.players.east.hand[0];
      if (openingTile === undefined)
        throw new Error("Automatic dealer has no tile.");
      const discarded = applyGameCommandV2(
        started.state,
        started.state.players.east.actorId,
        { type: "game/discard", tileId: openingTile },
      );
      if (!discarded.accepted || discarded.state === undefined) {
        throw new Error("Automatic fixture discard failed.");
      }
      const expired = decideReactionExpiration(discarded.state);
      if (!expired.accepted)
        throw new Error("Automatic reaction did not expire.");
      let awaitingDraw = discarded.state;
      for (const event of expired.events) {
        const next = reduceVersionedGameEvent(awaitingDraw, event);
        if (next.schemaVersion !== 2)
          throw new Error("Automatic fixture regressed.");
        awaitingDraw = next;
      }
      if (awaitingDraw.phase !== "awaiting-draw") {
        throw new Error("Automatic fixture is not awaiting a draw.");
      }
      const prepared = await prepareGameEventBatch(undefined, [
        started.event,
        ...discarded.events,
        ...expired.events,
      ]);
      const targetPlayer = gamePlayerAt(awaitingDraw, awaitingDraw.turn);
      const targetActorId = targetPlayer.actorId;
      await runInDurableObject(stub, (_instance, state) => {
        persistPreparedGameBatch(state.storage, prepared, (sql) => {
          if (kind === "disconnect") {
            sql.exec(
              "INSERT OR IGNORE INTO members (actor_id, display_name, role, joined_at) VALUES (?, 'Automatic Player', 'member', 1)",
              targetActorId,
            );
            sql.exec(
              "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES (?, ?, 'Automatic Player', 1)",
              awaitingDraw.turn,
              targetActorId,
            );
            sql.exec(
              "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES (?, 9, 0, 0)",
              targetActorId,
            );
            scheduleDeadline(sql, {
              deadlineId: "disconnect:automatic",
              dueAt: 0,
              kind: "disconnect",
              payload: {
                type: "system/disconnect-grace-expired",
                actorId: targetActorId,
                connectionGeneration: 9,
              },
              status: "pending",
              targetGeneration: 9,
            });
          } else {
            scheduleDeadline(sql, {
              deadlineId: "turn:automatic",
              dueAt: 0,
              kind: "turn",
              payload: {
                type: "system/turn-expired",
                openingSequence: awaitingDraw.sequence,
                phase: "awaiting-draw",
                seat: awaitingDraw.turn,
              },
              status: "pending",
              targetGeneration: awaitingDraw.sequence,
            });
          }
        });
      });
      await runInDurableObject(stub, (instance) => instance.alarm());
      await expect(
        runInDurableObject(stub, (_instance, state) => {
          const eventValues = state.storage.sql
            .exec<{ event_json: string }>(
              "SELECT event_json FROM game_events ORDER BY sequence",
            )
            .toArray()
            .map(
              ({ event_json }) =>
                JSON.parse(event_json) as Record<string, unknown>,
            );
          return {
            autopilot:
              kind === "disconnect"
                ? state.storage.sql
                    .exec<{ autopilot: number }>(
                      "SELECT autopilot FROM player_automation WHERE actor_id = ?",
                      targetActorId,
                    )
                    .one().autopilot
                : 0,
            forbidden: eventValues
              .map((event) => event["type"])
              .filter(
                (type) =>
                  type === "game/self-win-declared" ||
                  type === "game/hand-completed" ||
                  type === "game/concealed-kong-declared" ||
                  type === "game/added-kong-proposed",
              ),
            lastTypes: eventValues.slice(-2).map((event) => event["type"]),
          };
        }),
      ).resolves.toEqual({
        autopilot: kind === "disconnect" ? 1 : 0,
        forbidden: [],
        lastTypes: ["game/turn-drawn", "game/discard-reaction-opened"],
      });
      const discardEvidence = await runInDurableObject(
        stub,
        (_instance, state) => {
          const tail = state.storage.sql
            .exec<{ event_json: string }>(
              "SELECT event_json FROM game_events ORDER BY sequence DESC LIMIT 2",
            )
            .toArray()
            .map(
              ({ event_json }) =>
                JSON.parse(event_json) as Record<string, unknown>,
            );
          const opened = tail[0];
          const drawn = tail[1];
          const replacementValue = drawn?.["replacementTileIds"];
          const replacements: readonly unknown[] = Array.isArray(
            replacementValue,
          )
            ? (replacementValue as readonly unknown[])
            : [];
          return {
            actual: opened?.["tileId"],
            expected: replacements.at(-1) ?? drawn?.["ordinaryTileId"],
          };
        },
      );
      expect(discardEvidence.actual).toBe(discardEvidence.expected);
    },
  );

  it("applies disconnect and abandonment generations and clears them on reconnect", async () => {
    const tableId = `presence-alarm-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES ('east', ?, ?, 0)",
        owner.id,
        owner.displayName,
      );
      sql.exec(
        "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES (?, 9, 0, 0)",
        owner.id,
      );
      sql.exec(
        "UPDATE room_lifecycle SET room_activity_generation = 5 WHERE singleton = 1",
      );
      scheduleDeadline(sql, {
        deadlineId: "disconnect:9",
        dueAt: 0,
        kind: "disconnect",
        payload: {
          type: "system/disconnect-grace-expired",
          actorId: owner.id,
          connectionGeneration: 9,
        },
        status: "pending",
        targetGeneration: 9,
      });
      scheduleDeadline(sql, {
        deadlineId: "abandonment:5",
        dueAt: 1,
        kind: "abandonment",
        payload: {
          type: "system/table-abandonment-expired",
          roomActivityGeneration: 5,
        },
        status: "pending",
        targetGeneration: 5,
      });
    });
    await runInDurableObject(stub, (instance) => instance.alarm());
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        abandoned: state.storage.sql
          .exec<{ abandoned: number }>(
            "SELECT abandoned FROM room_lifecycle WHERE singleton = 1",
          )
          .one().abandoned,
        autopilot: state.storage.sql
          .exec<{ autopilot: number }>(
            "SELECT autopilot FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().autopilot,
        receipts: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM system_command_receipts",
          )
          .one().count,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      })),
    ).resolves.toEqual({
      abandoned: 1,
      autopilot: 1,
      receipts: 2,
      stateVersion: 2,
    });

    const activated = await activateSession(stub, binding, owner.id, 1);
    expect(activated.status).toBe(200);
    await activated.body?.cancel();
    const reconnected = await openSocket(stub, binding, 1);
    expect(reconnected.initial).toMatchObject({
      stateVersion: 3,
    });
    expect(reconnected.initial.view.seats[0]).toMatchObject({
      autopilot: false,
      occupant: owner,
      seat: "east",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        abandoned: state.storage.sql
          .exec<{ abandoned: number }>(
            "SELECT abandoned FROM room_lifecycle WHERE singleton = 1",
          )
          .one().abandoned,
        autopilot: state.storage.sql
          .exec<{ autopilot: number }>(
            "SELECT autopilot FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().autopilot,
        generation: state.storage.sql
          .exec<{ connection_generation: number }>(
            "SELECT connection_generation FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().connection_generation,
      })),
    ).resolves.toEqual({ abandoned: 0, autopilot: 0, generation: 10 });
    await runInDurableObject(stub, (_instance, state) => {
      scheduleDeadline(state.storage.sql, {
        deadlineId: "disconnect:stale-generation",
        dueAt: 0,
        kind: "disconnect",
        payload: {
          type: "system/disconnect-grace-expired",
          actorId: owner.id,
          connectionGeneration: 9,
        },
        status: "pending",
        targetGeneration: 9,
      });
    });
    await runInDurableObject(stub, (instance) => instance.alarm());
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        autopilot: state.storage.sql
          .exec<{ autopilot: number }>(
            "SELECT autopilot FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().autopilot,
        resultJson: state.storage.sql
          .exec<{ result_json: string }>(
            "SELECT result_json FROM system_command_receipts WHERE command_id = 'disconnect:stale-generation'",
          )
          .one().result_json,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      })),
    ).resolves.toEqual({
      autopilot: 0,
      resultJson: '{"outcome":"no-op","reason":"stale-target"}',
      stateVersion: 3,
    });
    reconnected.socket.close(1000, "test complete");
  });

  it("keeps lobby abandonment visible until a seated player reconnects", async () => {
    const tableId = `spectator-abandonment-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const ownerActivation = await activateSession(stub, binding, owner.id, 1);
    expect(ownerActivation.status).toBe(200);
    await ownerActivation.body?.cancel();
    await addMember(stub, binding, member);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES ('east', ?, ?, 0)",
        owner.id,
        owner.displayName,
      );
      state.storage.sql.exec(
        "INSERT INTO player_automation (actor_id, connection_generation, autopilot, updated_at) VALUES (?, 4, 0, 0)",
        owner.id,
      );
      state.storage.sql.exec(
        "UPDATE room_lifecycle SET abandoned = 1, room_activity_generation = 7 WHERE singleton = 1",
      );
      state.storage.sql.exec(
        "UPDATE lobby_state SET state_version = 1 WHERE singleton = 1",
      );
    });

    const spectator = await openSocket(stub, binding, 1, member);
    expect(spectator.initial).toMatchObject({
      stateVersion: 1,
      view: { phase: "abandoned", viewer: { role: "spectator" } },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        abandoned: state.storage.sql
          .exec<{ abandoned: number }>(
            "SELECT abandoned FROM room_lifecycle WHERE singleton = 1",
          )
          .one().abandoned,
        spectatorAutomation: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM player_automation WHERE actor_id = ?",
            member.id,
          )
          .one().count,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      })),
    ).resolves.toEqual({
      abandoned: 1,
      spectatorAutomation: 0,
      stateVersion: 1,
    });

    const seated = await openSocket(stub, binding, 1, owner);
    expect(seated.initial).toMatchObject({
      stateVersion: 2,
      view: {
        phase: "lobby",
        viewer: { role: "player", seat: "east" },
      },
    });
    await expect(
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ abandoned: number }>(
              "SELECT abandoned FROM room_lifecycle WHERE singleton = 1",
            )
            .one().abandoned,
      ),
    ).resolves.toBe(0);
    spectator.socket.close(1000, "test complete");
    seated.socket.close(1000, "test complete");
  });

  it("recovers silently expired socket presence after eviction", async () => {
    const tableId = `silent-expiry-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const activation = await activateSession(stub, binding, owner.id, 1);
    expect(activation.status).toBe(200);
    await activation.body?.cancel();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES ('east', ?, ?, 0)",
        owner.id,
        owner.displayName,
      );
    });
    const connection = await openSocket(stub, binding, 1, owner);
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets()[0];
      const attachment = socket?.deserializeAttachment() as
        Record<string, unknown> | null | undefined;
      if (
        socket === undefined ||
        attachment === null ||
        attachment === undefined
      ) {
        throw new Error("Silent-expiry fixture has no socket attachment.");
      }
      const expiredAt = Date.now() - 15 * 60_000 - 1;
      socket.serializeAttachment({
        ...attachment,
        sessionExpiresAt: expiredAt,
      });
      state.storage.sql.exec(
        "UPDATE connection_grants SET expires_at = ?",
        expiredAt,
      );
      state.storage.sql.exec(
        "UPDATE deadlines SET due_at = ? WHERE kind IN ('disconnect', 'abandonment') AND status = 'pending'",
        Date.now() - 1,
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance) => instance.alarm());
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        abandoned: state.storage.sql
          .exec<{ abandoned: number }>(
            "SELECT abandoned FROM room_lifecycle WHERE singleton = 1",
          )
          .one().abandoned,
        autopilot: state.storage.sql
          .exec<{ autopilot: number }>(
            "SELECT autopilot FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().autopilot,
        receipts: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM system_command_receipts",
          )
          .one().count,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      })),
    ).resolves.toEqual({
      abandoned: 1,
      autopilot: 1,
      receipts: 2,
      stateVersion: 2,
    });
    void connection;
  });

  it("arms silent-expiry autopilot when a connected spectator claims a seat", async () => {
    const tableId = `claim-expiry-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const activation = await activateSession(stub, binding, owner.id, 1);
    expect(activation.status).toBe(200);
    await activation.body?.cancel();
    const connection = await openSocket(stub, binding, 1, owner);
    expect(connection.initial.view.viewer.role).toBe("spectator");
    const claimMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      connection.socket,
      2,
    );
    connection.socket.send(
      commandMessage("claim-before-expiry", 0, {
        type: "lobby/claim-seat",
        seat: "east",
      }),
    );
    expect((await claimMessages)[0]).toMatchObject({
      outcome: "applied",
      stateVersion: 1,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        automations: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().count,
        expiryDeadlines: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM deadlines WHERE deadline_id LIKE 'disconnect-expiry:%' AND status = 'pending'",
          )
          .one().count,
      })),
    ).resolves.toEqual({ automations: 1, expiryDeadlines: 1 });
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets()[0];
      const attachment = socket?.deserializeAttachment() as
        Record<string, unknown> | null | undefined;
      if (
        socket === undefined ||
        attachment === null ||
        attachment === undefined
      ) {
        throw new Error("Claim-expiry fixture has no socket attachment.");
      }
      const expiredAt = Date.now() - 15_001;
      socket.serializeAttachment({
        ...attachment,
        sessionExpiresAt: expiredAt,
      });
      state.storage.sql.exec(
        "UPDATE connection_grants SET expires_at = ?",
        expiredAt,
      );
      state.storage.sql.exec(
        "UPDATE deadlines SET due_at = ? WHERE kind = 'disconnect' AND status = 'pending'",
        Date.now() - 1,
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance) => instance.alarm());
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        autopilot: state.storage.sql
          .exec<{ autopilot: number }>(
            "SELECT autopilot FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().autopilot,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      })),
    ).resolves.toEqual({ autopilot: 1, stateVersion: 2 });
  });

  it("moves derived actor and table expiry deadlines when the latest socket closes", async () => {
    const tableId = `decreasing-expiry-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const activation = await activateSession(stub, binding, owner.id, 1);
    expect(activation.status).toBe(200);
    await activation.body?.cancel();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO lobby_seats (seat, actor_id, display_name, ready) VALUES ('east', ?, ?, 0)",
        owner.id,
        owner.displayName,
      );
    });
    const base = Date.now();
    const laterExpiry = base + 180_000;
    const earlierExpiry = base + 60_000;
    const later = await openSocket(stub, binding, 1, owner, laterExpiry);
    const earlier = await openSocket(stub, binding, 1, owner, earlierExpiry);
    const before = await runInDurableObject(stub, (_instance, state) => {
      const generation = state.storage.sql
        .exec<{ connection_generation: number }>(
          "SELECT connection_generation FROM player_automation WHERE actor_id = ?",
          owner.id,
        )
        .one().connection_generation;
      const lifecycleGeneration = state.storage.sql
        .exec<{ room_activity_generation: number }>(
          "SELECT room_activity_generation FROM room_lifecycle WHERE singleton = 1",
        )
        .one().room_activity_generation;
      return {
        abandonmentDue: state.storage.sql
          .exec<{ due_at: number }>(
            "SELECT due_at FROM deadlines WHERE kind = 'abandonment' AND target_generation = ? AND status = 'pending'",
            lifecycleGeneration,
          )
          .one().due_at,
        disconnectDue: state.storage.sql
          .exec<{ due_at: number }>(
            "SELECT due_at FROM deadlines WHERE kind = 'disconnect' AND target_generation = ? AND status = 'pending'",
            generation,
          )
          .one().due_at,
      };
    });
    expect(before).toEqual({
      abandonmentDue: laterExpiry + 15 * 60_000,
      disconnectDue: laterExpiry + 15_000,
    });

    await runInDurableObject(stub, async (instance, state) => {
      const laterSocket = state.getWebSockets().find((socket) => {
        const attachment = socket.deserializeAttachment() as {
          readonly sessionExpiresAt?: unknown;
        } | null;
        return attachment?.sessionExpiresAt === laterExpiry;
      });
      if (laterSocket === undefined) {
        throw new Error("Later-expiring server socket is missing.");
      }
      await instance.webSocketClose(laterSocket, 1000, "test close", true);
    });
    const after = await runInDurableObject(stub, async (_instance, state) => {
      const generation = state.storage.sql
        .exec<{ connection_generation: number }>(
          "SELECT connection_generation FROM player_automation WHERE actor_id = ?",
          owner.id,
        )
        .one().connection_generation;
      const lifecycleGeneration = state.storage.sql
        .exec<{ room_activity_generation: number }>(
          "SELECT room_activity_generation FROM room_lifecycle WHERE singleton = 1",
        )
        .one().room_activity_generation;
      return {
        alarm: await state.storage.getAlarm(),
        abandonmentDue: state.storage.sql
          .exec<{ deadline_id: string; due_at: number }>(
            "SELECT deadline_id, due_at FROM deadlines WHERE kind = 'abandonment' AND target_generation = ? AND status = 'pending'",
            lifecycleGeneration,
          )
          .one(),
        disconnectDue: state.storage.sql
          .exec<{ deadline_id: string; due_at: number }>(
            "SELECT deadline_id, due_at FROM deadlines WHERE kind = 'disconnect' AND target_generation = ? AND status = 'pending'",
            generation,
          )
          .one(),
      };
    });
    expect(after.alarm).toBe(earlierExpiry + 15_000);
    expect(after.abandonmentDue.due_at).toBe(earlierExpiry + 15 * 60_000);
    expect(after.abandonmentDue.deadline_id.length).toBeGreaterThan(0);
    expect(after.disconnectDue.due_at).toBe(earlierExpiry + 15_000);
    expect(after.disconnectDue.deadline_id.length).toBeGreaterThan(0);
    await runInDurableObject(stub, (instance) => instance.alarm());
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        receipts: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM system_command_receipts",
          )
          .one().count,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      })),
    ).resolves.toEqual({ receipts: 0, stateVersion: 0 });

    const deadlineEvidence = () =>
      runInDurableObject(stub, (_instance, state) => ({
        abandoned: state.storage.sql
          .exec<{ abandoned: number }>(
            "SELECT abandoned FROM room_lifecycle WHERE singleton = 1",
          )
          .one().abandoned,
        autopilot: state.storage.sql
          .exec<{ autopilot: number }>(
            "SELECT autopilot FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().autopilot,
        deadlines: state.storage.sql
          .exec<{ deadline_id: string; status: string }>(
            "SELECT deadline_id, status FROM deadlines WHERE deadline_id IN (?, ?) ORDER BY kind",
            after.abandonmentDue.deadline_id,
            after.disconnectDue.deadline_id,
          )
          .toArray(),
        eventCount: state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM game_events")
          .one().count,
        receipts: state.storage.sql
          .exec<{ command_id: string; result_json: string }>(
            "SELECT command_id, result_json FROM system_command_receipts ORDER BY command_id",
          )
          .toArray()
          .map(({ command_id, result_json }) => ({
            commandId: command_id,
            result: JSON.parse(result_json) as unknown,
          })),
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      }));

    const simulatedExpiry = Date.now() - 1;
    await runInDurableObject(stub, async (instance, state) => {
      const remainingSocket = state.getWebSockets().find((socket) => {
        const attachment = socket.deserializeAttachment() as {
          readonly sessionExpiresAt?: unknown;
        } | null;
        return attachment?.sessionExpiresAt === earlierExpiry;
      });
      const attachment = remainingSocket?.deserializeAttachment() as
        Record<string, unknown> | null | undefined;
      if (
        remainingSocket === undefined ||
        attachment === null ||
        attachment === undefined
      ) {
        throw new Error("Earlier-expiring server socket is missing.");
      }
      remainingSocket.serializeAttachment({
        ...attachment,
        sessionExpiresAt: simulatedExpiry,
      });
      state.storage.sql.exec(
        "UPDATE connection_grants SET expires_at = ?",
        simulatedExpiry,
      );
      state.storage.sql.exec(
        "UPDATE deadlines SET due_at = ? WHERE deadline_id = ?",
        simulatedExpiry + 15_000,
        after.disconnectDue.deadline_id,
      );
      state.storage.sql.exec(
        "UPDATE deadlines SET due_at = ? WHERE deadline_id = ?",
        simulatedExpiry + 15 * 60_000,
        after.abandonmentDue.deadline_id,
      );
      await instance.webSocketClose(
        remainingSocket,
        1000,
        "expired fixture close",
        true,
      );
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        abandonment: state.storage.sql
          .exec<{ due_at: number; status: string }>(
            "SELECT due_at, status FROM deadlines WHERE deadline_id = ?",
            after.abandonmentDue.deadline_id,
          )
          .one(),
        disconnect: state.storage.sql
          .exec<{ due_at: number; status: string }>(
            "SELECT due_at, status FROM deadlines WHERE deadline_id = ?",
            after.disconnectDue.deadline_id,
          )
          .one(),
      })),
    ).resolves.toEqual({
      abandonment: {
        due_at: simulatedExpiry + 15 * 60_000,
        status: "pending",
      },
      disconnect: {
        due_at: simulatedExpiry + 15_000,
        status: "pending",
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE deadlines SET due_at = ? WHERE deadline_id = ?",
        Date.now() - 1,
        after.disconnectDue.deadline_id,
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance) => instance.alarm());
    const afterDisconnect = await deadlineEvidence();
    expect(afterDisconnect).toEqual({
      abandoned: 0,
      autopilot: 1,
      deadlines: [
        {
          deadline_id: after.abandonmentDue.deadline_id,
          status: "pending",
        },
        {
          deadline_id: after.disconnectDue.deadline_id,
          status: "processed",
        },
      ],
      eventCount: 0,
      receipts: [
        {
          commandId: after.disconnectDue.deadline_id,
          result: { outcome: "processed", publicTransition: true },
        },
      ],
      stateVersion: 1,
    });

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.setAlarm(before.disconnectDue);
      await instance.alarm();
    });
    await expect(deadlineEvidence()).resolves.toEqual(afterDisconnect);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE deadlines SET due_at = ? WHERE deadline_id = ?",
        Date.now() - 1,
        after.abandonmentDue.deadline_id,
      );
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance) => instance.alarm());
    const afterAbandonment = await deadlineEvidence();
    expect(afterAbandonment).toEqual({
      abandoned: 1,
      autopilot: 1,
      deadlines: [
        {
          deadline_id: after.abandonmentDue.deadline_id,
          status: "processed",
        },
        {
          deadline_id: after.disconnectDue.deadline_id,
          status: "processed",
        },
      ],
      eventCount: 0,
      receipts: [
        {
          commandId: after.abandonmentDue.deadline_id,
          result: { outcome: "processed", publicTransition: true },
        },
        {
          commandId: after.disconnectDue.deadline_id,
          result: { outcome: "processed", publicTransition: true },
        },
      ],
      stateVersion: 2,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        pendingAbandonmentCount: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM deadlines d JOIN room_lifecycle r ON r.singleton = 1 AND r.room_activity_generation = d.target_generation WHERE d.kind = 'abandonment' AND d.status = 'pending'",
          )
          .one().count,
        replacementStatus: state.storage.sql
          .exec<{ status: string }>(
            "SELECT status FROM deadlines WHERE deadline_id = ?",
            after.abandonmentDue.deadline_id,
          )
          .one().status,
      })),
    ).resolves.toEqual({
      pendingAbandonmentCount: 0,
      replacementStatus: "processed",
    });

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.setAlarm(before.abandonmentDue);
      await instance.alarm();
    });
    await expect(deadlineEvidence()).resolves.toEqual(afterAbandonment);
    later.socket.close(1000, "test complete");
    earlier.socket.close(1000, "test complete");
  });

  it("retires automation on leave and makes an old disconnect delivery a no-op", async () => {
    const tableId = `leave-presence-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const activation = await activateSession(stub, binding, owner.id, 1);
    expect(activation.status).toBe(200);
    await activation.body?.cancel();
    const connection = await openSocket(stub, binding, 1, owner);
    const claimMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      connection.socket,
      2,
    );
    connection.socket.send(
      commandMessage("claim-then-leave", 0, {
        type: "lobby/claim-seat",
        seat: "east",
      }),
    );
    await claimMessages;
    const generation = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ connection_generation: number }>(
            "SELECT connection_generation FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().connection_generation,
    );
    const leaveMessages = nextMessages<ReceiptMessage | SnapshotMessage>(
      connection.socket,
      2,
    );
    connection.socket.send(
      commandMessage("leave-after-claim", 1, {
        type: "lobby/leave-seat",
      }),
    );
    expect((await leaveMessages)[0]).toMatchObject({
      outcome: "applied",
      stateVersion: 2,
    });
    await runInDurableObject(stub, (_instance, state) => {
      scheduleDeadline(state.storage.sql, {
        deadlineId: "disconnect:late-unseated",
        dueAt: Date.now() - 1,
        kind: "disconnect",
        payload: {
          type: "system/disconnect-grace-expired",
          actorId: owner.id,
          connectionGeneration: generation,
        },
        status: "pending",
        targetGeneration: generation,
      });
    });
    await runInDurableObject(stub, (instance) => instance.alarm());
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        automations: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM player_automation WHERE actor_id = ?",
            owner.id,
          )
          .one().count,
        oldPending: state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM deadlines WHERE deadline_id LIKE 'disconnect-expiry:%' AND status = 'pending'",
          )
          .one().count,
        resultJson: state.storage.sql
          .exec<{ result_json: string }>(
            "SELECT result_json FROM system_command_receipts WHERE command_id = 'disconnect:late-unseated'",
          )
          .one().result_json,
        stateVersion: state.storage.sql
          .exec<{ state_version: number }>(
            "SELECT state_version FROM lobby_state WHERE singleton = 1",
          )
          .one().state_version,
      })),
    ).resolves.toEqual({
      automations: 0,
      oldPending: 0,
      resultJson: '{"outcome":"no-op","reason":"stale-target"}',
      stateVersion: 2,
    });
    connection.socket.close(1000, "test complete");
  });

  it("repairs the platform alarm from the persisted queue after eviction", async () => {
    const tableId = `alarm-repair-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const created = await createTable(stub, tableId);
    const dueAt = Date.now() + 120_000;
    await runInDurableObject(stub, async (_instance, state) => {
      scheduleDeadline(state.storage.sql, {
        deadlineId: "reaction:repair",
        dueAt,
        kind: "reaction",
        payload: {
          type: "system/reaction-expired",
          openingSequence: 1,
          windowId: "repair-window",
        },
        status: "pending",
        targetGeneration: 1,
      });
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    const replay = await post(
      stub,
      "/internal/bindings/apply",
      created.request,
    );
    expect(replay.status).toBe(200);
    await replay.body?.cancel();
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(dueAt);
  });

  it.each([
    "tampered-hash",
    "missing-event",
    "reordered",
    "checkpoint",
  ] as const)(
    "fails closed when the persisted game chain has %s corruption",
    async (corruption) => {
      const tableId = `game-corrupt-${corruption}-${crypto.randomUUID()}`;
      const stub = tableRoom(tableId);
      await createTable(stub, tableId);
      const fixture = await installGameChain(stub);
      await runInDurableObject(stub, (_instance, state) => {
        if (corruption === "tampered-hash") {
          state.storage.sql.exec(
            "UPDATE game_events SET event_hash = ? WHERE sequence = 2",
            "0".repeat(64),
          );
        } else if (corruption === "missing-event") {
          state.storage.sql.exec("DELETE FROM game_events WHERE sequence = 1");
        } else if (corruption === "reordered") {
          state.storage.sql.exec(
            "UPDATE game_events SET sequence = 99 WHERE sequence = 1",
          );
          state.storage.sql.exec(
            "UPDATE game_events SET sequence = 1 WHERE sequence = 2",
          );
          state.storage.sql.exec(
            "UPDATE game_events SET sequence = 2 WHERE sequence = 99",
          );
        } else {
          state.storage.sql.exec(
            "UPDATE canonical_game_state SET state_json = ? WHERE singleton = 1",
            fixture.genesisStateJson,
          );
        }
      });
      await evictDurableObject(stub);
      await expect(
        post(stub, "/internal/bindings/apply", {
          version: 1,
          operationId: crypto.randomUUID(),
          instanceId: "instance-original",
          actor: owner,
          deadlineAt: Date.now() + 60_000,
          intent: { kind: "create" },
        }),
      ).rejects.toThrow(/game|event|checkpoint|chain/iu);
    },
  );

  it("refuses to open an unsupported persisted schema version", async () => {
    const tableId = `schema-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE storage_metadata SET schema_version = 999 WHERE singleton = 1",
      );
    });
    await evictDurableObject(stub);
    await expect(
      post(stub, "/internal/bindings/apply", {
        version: 1,
        operationId: crypto.randomUUID(),
        instanceId: "instance-schema",
        actor: owner,
        deadlineAt: Date.now() + 60_000,
        intent: { kind: "create" },
      }),
    ).rejects.toThrow(/Unsupported TableRoom storage schema version/u);
  });

  it("fails closed instead of recreating missing current-schema state", async () => {
    for (const missingTable of ["lobby_seats", "members"] as const) {
      const tableId = `corrupt-${missingTable}-${crypto.randomUUID()}`;
      const stub = tableRoom(tableId);
      await createTable(stub, tableId);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`DROP TABLE ${missingTable}`);
      });
      await evictDurableObject(stub);

      await expect(
        post(stub, "/internal/bindings/apply", {
          version: 1,
          operationId: crypto.randomUUID(),
          instanceId: "instance-original",
          actor: owner,
          deadlineAt: Date.now() + 60_000,
          intent: { kind: "create" },
        }),
      ).rejects.toThrow(new RegExp(`${missingTable}|no such table`, "u"));
    }
  });

  it.each(["", "?protocolVersion=1", "?protocolVersion=99"])(
    "sends an upgrade control frame and closes unsupported socket protocol %s",
    async (query) => {
      const stub = tableRoom(`protocol-upgrade-${crypto.randomUUID()}`);
      const response = await stub.fetch(
        new Request(`https://table-room.internal/connect${query}`, {
          headers: { Upgrade: "websocket" },
        }),
      );
      expect(response.status).toBe(101);
      const socket = response.webSocket;
      if (socket === null) throw new Error("Upgrade rejection has no socket.");
      const control = nextMessage(socket);
      const close = nextClose(socket);
      socket.accept();
      await expect(control).resolves.toEqual({
        minimumSupportedVersion: 2,
        protocolVersion: 2,
        type: "table/upgrade-required",
      });
      await expect(close).resolves.toMatchObject({ code: 4406 });
    },
  );

  it.each(["before", "exact", "after"] as const)(
    "orders a player reaction %s the persisted deadline through the command pipeline",
    async (timing) => {
      const tableId = `deadline-race-${timing}-${crypto.randomUUID()}`;
      const stub = tableRoom(tableId);
      const { binding } = await createTable(stub, tableId);
      const started = startHongKongV2Game(
        {
          east: `${timing}:east`,
          south: `${timing}:south`,
          west: `${timing}:west`,
          north: `${timing}:north`,
        },
        Uint8Array.from(
          { length: 1_028 },
          (_, index) => (index * 61 + 5) & 0xff,
        ),
      );
      const openingTile = started.state.players.east.hand[0];
      if (openingTile === undefined)
        throw new Error("Race dealer has no tile.");
      const discarded = applyGameCommandV2(
        started.state,
        started.state.players.east.actorId,
        { type: "game/discard", tileId: openingTile },
      );
      if (!discarded.accepted || discarded.state === undefined) {
        throw new Error("Race fixture discard failed.");
      }
      const window = discarded.state.reactionWindow;
      if (window === null) throw new Error("Race fixture has no reaction.");
      const responderSeat = window.responderOrder[0];
      const responder = gamePlayerAt(discarded.state, responderSeat);
      const actor = {
        displayName: `Race ${timing}`,
        id: responder.actorId,
      };
      const prepared = await prepareGameEventBatch(undefined, [
        started.event,
        ...discarded.events,
      ]);
      await runInDurableObject(stub, (_instance, state) => {
        persistPreparedGameBatch(state.storage, prepared, (sql) => {
          sql.exec(
            "INSERT OR IGNORE INTO members (actor_id, display_name, role, joined_at) VALUES (?, ?, 'member', 1)",
            actor.id,
            actor.displayName,
          );
          sql.exec(
            "INSERT INTO actor_sessions (actor_id, session_generation, activated_at) VALUES (?, 1, 1)",
            actor.id,
          );
          scheduleDeadline(sql, {
            deadlineId: "reaction:race",
            dueAt: Date.now() + 60_000,
            kind: "reaction",
            payload: {
              type: "system/reaction-expired",
              openingSequence: window.openingSequence,
              windowId: window.id,
            },
            status: "pending",
            targetGeneration: window.openingSequence,
          });
        });
      });
      const connection = await openSocket(stub, binding, 1, actor);
      const boundary = Date.now();
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE deadlines SET due_at = ? WHERE deadline_id = 'reaction:race'",
          timing === "before"
            ? boundary + 60_000
            : timing === "exact"
              ? boundary
              : boundary - 1,
        );
      });
      const receipt = nextReceipt(connection.socket);
      connection.socket.send(
        commandMessage(`race-${timing}`, 0, {
          type: "game/react",
          windowId: window.id,
          response: { type: "pass" },
        }),
      );
      await expect(receipt).resolves.toMatchObject(
        timing === "before"
          ? { outcome: "applied", stateVersion: 0 }
          : {
              error: { code: "stale-state-version" },
              outcome: "rejected",
              stateVersion: 1,
            },
      );
      await expect(
        runInDurableObject(stub, (_instance, state) => ({
          playerReceipts: state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM lobby_command_receipts",
            )
            .one().count,
          systemReceipts: state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM system_command_receipts",
            )
            .one().count,
        })),
      ).resolves.toEqual({
        playerReceipts: 1,
        systemReceipts: timing === "before" ? 0 : 1,
      });
      connection.socket.close(1000, "test complete");
    },
  );

  it("checks active session generation on connect and every socket message", async () => {
    const tableId = `socket-${crypto.randomUUID()}`;
    const stub = tableRoom(tableId);
    const { binding } = await createTable(stub, tableId);
    const authorization = bindingAuthorization(binding);

    const firstSession = 1;
    const activated = await post(stub, "/internal/sessions/activate", {
      version: 1,
      ...authorization,
      actorId: owner.id,
      sessionGeneration: firstSession,
    });
    expect(activated.status).toBe(200);
    await activated.body?.cancel();

    const upgrade = await connect(stub, binding, firstSession);
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    if (socket === null)
      throw new Error("WebSocket upgrade returned no socket.");
    const initialMessage = nextMessage(socket);
    socket.accept();
    const initial = await initialMessage;
    expect(initial).toMatchObject({
      type: "table/snapshot",
      view: {
        tableId,
        viewer: { actor: owner },
      },
    });

    const secondSession = 2;
    const replaced = await post(stub, "/internal/sessions/activate", {
      version: 1,
      ...authorization,
      actorId: owner.id,
      sessionGeneration: secondSession,
    });
    expect(replaced.status).toBe(200);
    await replaced.body?.cancel();

    const close = nextClose(socket);
    await expect(close).resolves.toMatchObject({ code: 4001 });

    const staleUpgrade = await connect(stub, binding, firstSession);
    expect(staleUpgrade.status).toBe(403);
    await staleUpgrade.body?.cancel();

    const currentUpgrade = await connect(stub, binding, secondSession);
    expect(currentUpgrade.status).toBe(101);
    const currentSocket = currentUpgrade.webSocket;
    expect(currentSocket).not.toBeNull();
    if (currentSocket === null)
      throw new Error("WebSocket upgrade returned no socket.");
    const currentInitialMessage = nextMessage(currentSocket);
    currentSocket.accept();
    const currentInitial = await currentInitialMessage;

    await evictDurableObject(stub);
    const resyncMessage = nextMessage(currentSocket);
    currentSocket.send(
      JSON.stringify({
        lastSeenStateVersion: 0,
        protocolVersion: 2,
        type: "table/resync",
      }),
    );
    expect(await resyncMessage).toEqual(currentInitial);
    currentSocket.close(1000, "test complete");
  });
});
