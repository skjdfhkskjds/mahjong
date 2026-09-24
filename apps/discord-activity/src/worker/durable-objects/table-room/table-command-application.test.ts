import { describe, expect, it } from "vitest";
import {
  decodeCanonicalGameEventJson,
  HONG_KONG_V1_RANDOM_BYTES,
  projectGameV1,
  startHongKongV1Game,
  type CanonicalGameStateV1,
} from "@mahjong/rules-hong-kong";

import {
  executeTableCommand,
  type CommandReceipt,
  type CommandState,
  type PreparedTableCommand,
  type TableCommandStore,
} from "./table-command-application.js";
import {
  prepareGameEventBatch,
  type PreparedGameEventBatch,
  type VerifiedStoredGame,
} from "./table-game-events.js";
import type { TableCommandEnvelope } from "./table-room-protocol.js";
import {
  controlsAfterPresence,
  prepareControllerWork,
} from "./table-controller-application.js";

class MemoryCommandStore implements TableCommandStore {
  public state: CommandState = {
    ownerId: "actor:east",
    controllers: { controls: [], jobs: [] },
    stateVersion: 0,
    gameExists: false,
    seats: [],
    memberDisplayName: "Player",
    presence: {
      tableExists: true,
      seatedActorIds: [],
      automation: [],
      lifecycle: { abandoned: false, roomActivityGeneration: 0 },
      deadlines: [],
    },
  };
  public readonly receipts = new Map<string, CommandReceipt>();
  public readonly commits: PreparedTableCommand[] = [];
  public game: VerifiedStoredGame | undefined;
  public failCommit = false;

  public receipt(commandId: string) {
    return this.receipts.get(commandId);
  }
  public commandState() {
    return this.state;
  }
  public controllerSnapshot() {
    return this.state.controllers;
  }
  public verifiedGame() {
    return Promise.resolve(this.game);
  }
  public install(batch: PreparedGameEventBatch) {
    const events: VerifiedStoredGame["events"] =
      this.game === undefined
        ? [
            decodeCanonicalGameEventJson(batch.rows[0].eventJson),
            ...batch.rows
              .slice(1)
              .map((row) => decodeCanonicalGameEventJson(row.eventJson)),
          ]
        : [
            ...this.game.events,
            ...batch.rows.map((row) =>
              decodeCanonicalGameEventJson(row.eventJson),
            ),
          ];
    this.game = {
      state: batch.finalState,
      lastEventHash: batch.lastEventHash,
      events,
    };
    this.state = { ...this.state, gameExists: true };
  }
  public commitCommand(
    change: PreparedTableCommand,
  ): ReturnType<TableCommandStore["commitCommand"]> {
    if (this.failCommit) throw new Error("Test store commit failed");
    const existing = this.receipts.get(change.commandId);
    if (existing !== undefined) return { kind: "duplicate", receipt: existing };
    this.commits.push(change);
    this.receipts.set(change.commandId, change.receipt);
    const seat = change.seatChange;
    let seats = this.state.seats;
    if (seat.kind === "remove")
      seats = seats.filter(({ actorId }) => actorId !== seat.actorId);
    else if (seat.kind === "put")
      seats = [
        ...seats.filter(({ actorId }) => actorId !== seat.seat.actorId),
        seat.seat,
      ];
    const botSeat = change.botSeatChange;
    let controls = controlsAfterPresence(
      this.state.controllers.controls,
      change.presence,
    );
    if (botSeat?.kind === "add") {
      seats = [...seats, botSeat.seat];
      controls = [
        ...controls,
        {
          actorId: botSeat.seat.actorId,
          kind: "BOT",
          controller: "BOT",
          generation: 0,
        },
      ];
    } else if (botSeat?.kind === "remove") {
      seats = seats.filter(({ actorId }) => actorId !== botSeat.actorId);
      controls = controls.filter(({ actorId }) => actorId !== botSeat.actorId);
    }
    const jobs = new Map(
      this.state.controllers.jobs.map((job) => [job.actorId, job]),
    );
    for (const actorId of change.botWork?.cancelActorIds ?? [])
      jobs.delete(actorId);
    for (const job of change.botWork?.upsert ?? []) jobs.set(job.actorId, job);
    const automation = new Map(
      this.state.presence.automation.map((entry) => [entry.actorId, entry]),
    );
    for (const entry of change.presence?.automation ?? []) {
      if (entry.type === "delete") automation.delete(entry.actorId);
      else automation.set(entry.automation.actorId, entry.automation);
    }
    this.state = {
      ...this.state,
      stateVersion: change.stateVersion,
      seats,
      controllers: { controls, jobs: [...jobs.values()] },
      presence: {
        ...this.state.presence,
        seatedActorIds: seats.map(({ actorId }) => actorId),
        automation: [...automation.values()],
      },
    };
    if (change.game !== undefined) this.install(change.game);
    return { kind: "committed" };
  }
}

const randomBytes = (length: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 41 + 17) & 0xff);
const players = {
  east: "actor:east",
  south: "actor:south",
  west: "actor:west",
  north: "actor:north",
};
function command(
  commandId: string,
  expectedStateVersion: number,
  value: TableCommandEnvelope["command"],
): TableCommandEnvelope {
  return { commandId, expectedStateVersion, command: value };
}
function execute(
  store: MemoryCommandStore,
  actorId: string,
  envelope: TableCommandEnvelope,
  overrides: Partial<Parameters<typeof executeTableCommand>[1]> = {},
) {
  const control = store
    .controllerSnapshot()
    .controls.find((entry) => entry.actorId === actorId);
  return executeTableCommand(store, {
    actorId,
    envelope,
    now: 100,
    observations: Object.values(players).map((actorId) => ({
      actorId,
      expiresAt: 1_000_000,
    })),
    randomBytes,
    authority: {
      kind: control?.controller ?? "HUMAN",
      generation: control?.generation ?? 0,
    },
    createCommandId: () => `job-${String(store.commits.length)}`,
    newBotActorId: () => "bot:00000000-0000-0000-0000-000000000001",
    ...overrides,
  });
}
function playerAt(
  state: CanonicalGameStateV1,
  seat: CanonicalGameStateV1["turn"],
) {
  const player = [
    state.players.east,
    state.players.south,
    state.players.west,
    state.players.north,
  ].find((player) => player.seat === seat);
  if (player === undefined) throw new Error("Game seat has no player");
  return player;
}

async function playingStore() {
  const store = new MemoryCommandStore();
  store.state = {
    ...store.state,
    seats: Object.entries(players).map(([seat, actorId]) => ({
      seat: seat as "east" | "south" | "west" | "north",
      actorId,
      displayName: seat,
      ready: true,
    })),
    controllers: {
      controls: Object.values(players).map((actorId) => ({
        actorId,
        kind: "HUMAN",
        controller: "HUMAN",
        generation: 1,
      })),
      jobs: [],
    },
    presence: {
      ...store.state.presence,
      seatedActorIds: Object.values(players),
      automation: Object.values(players).map((actorId) => ({
        actorId,
        autopilot: false,
        connectionGeneration: 1,
      })),
    },
  };
  const started = startHongKongV1Game(
    players,
    randomBytes(HONG_KONG_V1_RANDOM_BYTES),
  );
  store.install(await prepareGameEventBatch(undefined, [started.event]));
  return store;
}

describe("table command application with a test store", () => {
  it("prepares owner-managed bot seating without creating human presence for the bot", async () => {
    const store = new MemoryCommandStore();
    await execute(
      store,
      "actor:east",
      command("claim", 0, { type: "lobby/claim-seat", seat: "east" }),
    );
    const added = await execute(
      store,
      "actor:east",
      command("add", 1, { type: "lobby/add-bot", seat: "south" }),
    );
    expect(added.applied).toBe(true);
    expect(store.commits.at(-1)).toMatchObject({
      botSeatChange: { kind: "add", seat: { ready: true, seat: "south" } },
      botWork: { cancelActorIds: [], upsert: [] },
    });
    await execute(
      store,
      "actor:east",
      command("move", 2, { type: "lobby/claim-seat", seat: "west" }),
    );
    expect(
      store.commits
        .at(-1)
        ?.presence?.automation.some(
          (change) =>
            change.type === "upsert" &&
            change.automation.actorId.startsWith("bot:"),
        ),
    ).toBe(false);
    const denied = await execute(
      store,
      "actor:north",
      command("denied", 3, { type: "lobby/remove-bot", seat: "south" }),
    );
    expect(JSON.parse(denied.response)).toMatchObject({
      error: { code: "owner-required" },
    });
    const removed = await execute(
      store,
      "actor:east",
      command("remove", 3, { type: "lobby/remove-bot", seat: "south" }),
    );
    expect(removed.applied).toBe(true);
    expect(
      store.state.controllers.controls.some(
        (control) => control.kind === "BOT",
      ),
    ).toBe(false);
  });

  it.each([false, true])(
    "retains the active-hand seat and deletes only its departing grant (another connection: %s)",
    async (anotherConnection) => {
      const store = await playingStore();
      const original = store.game?.state;
      if (original?.schemaVersion !== 1) throw new Error("Missing game.");
      const actorId = playerAt(original, original.turn).actorId;
      const beforeSeats = store.state.seats;
      const outcome = await execute(
        store,
        actorId,
        command("leave", 0, { type: "lobby/leave-seat" }),
        {
          departingConnectionGeneration: "exact-departing-grant",
          observations: anotherConnection
            ? [{ actorId, expiresAt: 10_000 }]
            : [],
        },
      );
      expect(outcome).toMatchObject({
        applied: true,
        broadcast: !anotherConnection,
      });
      expect(store.state.seats).toEqual(beforeSeats);
      expect(store.game?.state).toEqual(original);
      expect(store.commits.at(-1)).toMatchObject({
        removeConnectionGeneration: "exact-departing-grant",
        seatChange: { kind: "none" },
      });
      const after = store.state.controllers.controls.find(
        (control) => control.actorId === actorId,
      );
      expect(after).toMatchObject({
        kind: "HUMAN",
        controller: anotherConnection ? "HUMAN" : "BOT",
        generation: anotherConnection ? 1 : 2,
      });
      expect(store.state.controllers.jobs).toHaveLength(
        anotherConnection ? 0 : 1,
      );
      if (!anotherConnection)
        expect(store.state.controllers.jobs[0]?.controllerGeneration).toBe(2);
    },
  );

  it("refuses stale controller authority before replay and after asynchronous game preparation", async () => {
    const store = await playingStore();
    const original = store.game?.state;
    if (original?.schemaVersion !== 1) throw new Error("Missing game.");
    const dealer = playerAt(original, original.turn);
    const tileId = dealer.hand[0];
    if (tileId === undefined) throw new Error("Missing tile.");
    const envelope = command("discard", 0, { type: "game/discard", tileId });
    const stale = await execute(store, dealer.actorId, envelope, {
      authority: { kind: "HUMAN", generation: 0 },
    });
    expect(JSON.parse(stale.response)).toMatchObject({
      error: { code: "inactive-controller" },
    });
    expect(stale.senderSnapshot).toBe(true);
    let reads = 0;
    store.controllerSnapshot = () => {
      reads += 1;
      return reads < 3
        ? store.state.controllers
        : {
            ...store.state.controllers,
            controls: store.state.controllers.controls.map((control) =>
              control.actorId === dealer.actorId
                ? { ...control, controller: "BOT", generation: 2 }
                : control,
            ),
          };
    };
    const changed = await execute(store, dealer.actorId, envelope);
    expect(JSON.parse(changed.response)).toMatchObject({
      error: { code: "inactive-controller" },
    });
    expect(changed.senderSnapshot).toBe(true);
    expect(store.commits).toHaveLength(0);
    expect(store.game?.state).toEqual(original);
  });

  it("replays an actor's identical retry without another commit or publication", async () => {
    const store = new MemoryCommandStore();
    const envelope = command("claim", 0, {
      type: "lobby/claim-seat",
      seat: "east",
    });
    const first = await execute(store, "actor:east", envelope);
    const replayed = await execute(store, "actor:east", envelope);
    expect(first).toMatchObject({ applied: true, broadcast: true });
    expect(replayed).toEqual({
      applied: false,
      broadcast: false,
      senderSnapshot: false,
      stale: false,
      response: first.response,
    });
    expect(store.commits).toHaveLength(1);
    expect(store.state.stateVersion).toBe(1);
  });

  it("rejects both payload and actor collisions without replacing the stored receipt", async () => {
    const store = new MemoryCommandStore();
    const envelope = command("claim", 0, {
      type: "lobby/claim-seat",
      seat: "east",
    });
    const first = await execute(store, "actor:east", envelope);
    for (const [actorId, retry] of [
      [
        "actor:east",
        command("claim", 0, { type: "lobby/claim-seat", seat: "west" }),
      ],
      ["actor:west", envelope],
    ] as const) {
      const result = await execute(store, actorId, retry);
      expect(result).toMatchObject({ applied: false, broadcast: false });
      expect(JSON.parse(result.response)).toMatchObject({
        outcome: "rejected",
        error: { code: "command-id-collision" },
      });
    }
    expect(store.commits).toHaveLength(1);
    expect(store.receipt("claim")?.response).toBe(first.response);
  });

  it("persists stale rejection and requests sender resynchronization on initial request and retry", async () => {
    const store = new MemoryCommandStore();
    store.state = { ...store.state, stateVersion: 4 };
    const envelope = command("stale", 3, {
      type: "lobby/claim-seat",
      seat: "east",
    });
    const rejected = await execute(store, "actor:east", envelope);
    const retried = await execute(store, "actor:east", envelope);
    expect(rejected).toMatchObject({
      applied: false,
      broadcast: false,
      stale: true,
    });
    expect(retried).toMatchObject({
      applied: false,
      broadcast: false,
      stale: true,
      response: rejected.response,
    });
    expect(JSON.parse(rejected.response)).toMatchObject({
      stateVersion: 4,
      error: { code: "stale-state-version" },
    });
    expect(store.commits).toHaveLength(1);
    expect(store.state.seats).toEqual([]);
  });

  it("commits a seat, public version, presence work, and receipt as one operation", async () => {
    const store = new MemoryCommandStore();
    const result = await execute(
      store,
      "actor:east",
      command("claim", 0, { type: "lobby/claim-seat", seat: "east" }),
    );
    expect(store.commits).toHaveLength(1);
    const committed = store.commits[0];
    expect(committed).toMatchObject({
      commandId: "claim",
      stateVersion: 1,
      seatChange: {
        kind: "put",
        seat: { actorId: "actor:east", seat: "east", ready: false },
      },
      receipt: { actorId: "actor:east", response: result.response },
    });
    expect(
      committed?.presence?.deadlineSchedules.find(
        ({ kind }) => kind === "disconnect",
      ),
    ).toMatchObject({ kind: "disconnect", payload: { actorId: "actor:east" } });
    expect(store.state.seats).toHaveLength(1);
    expect(JSON.parse(result.response)).toMatchObject({
      stateVersion: 1,
      outcome: "applied",
    });
  });

  it("does not return publication or acknowledgement when the atomic commit fails", async () => {
    const store = new MemoryCommandStore();
    store.failCommit = true;
    await expect(
      execute(
        store,
        "actor:east",
        command("claim", 0, { type: "lobby/claim-seat", seat: "east" }),
      ),
    ).rejects.toThrow("Test store commit failed");
    expect(store.state.seats).toEqual([]);
    expect(store.receipts.size).toBe(0);
    expect(store.state.stateVersion).toBe(0);
  });

  it("keeps private reactions at one public revision and publishes only resolution", async () => {
    const store = await playingStore();
    const initial = store.game?.state;
    if (initial?.schemaVersion !== 1) throw new Error("Expected game");
    const dealer = playerAt(initial, initial.turn);
    const tileId = dealer.hand[0];
    if (tileId === undefined) throw new Error("Expected dealer tile");
    await execute(
      store,
      dealer.actorId,
      command("discard", 0, { type: "game/discard", tileId }),
    );
    const opened = store.game?.state;
    if (opened?.schemaVersion !== 1 || opened.reactionWindow === null)
      throw new Error("Expected reaction window");
    const responders = opened.reactionWindow.responderOrder.map(
      (seat) => playerAt(opened, seat).actorId,
    );
    const observer = responders[1];
    if (observer === undefined) throw new Error("Expected observer");
    store.state = {
      ...store.state,
      controllers: {
        controls: store.state.controllers.controls.map((control) =>
          responders.slice(0, 2).includes(control.actorId)
            ? { ...control, controller: "BOT" }
            : control,
        ),
        jobs: [],
      },
    };
    let nextJob = 0;
    const scheduled = prepareControllerWork({
      controls: store.state.controllers.controls,
      jobs: [],
      game: opened,
      now: 50,
      abandoned: false,
      createCommandId: () => `pending-${String(nextJob++)}`,
    });
    store.state = {
      ...store.state,
      controllers: { ...store.state.controllers, jobs: scheduled.upsert },
    };
    const before = projectGameV1(opened, observer);
    for (const [index, actorId] of responders.entries()) {
      const envelope = command(`pass-${String(index)}`, 1, {
        type: "game/react",
        response: { type: "pass" },
        windowId: opened.reactionWindow.id,
      });
      const result = await execute(store, actorId, envelope);
      const privateSubmission = index < 2;
      expect(result).toMatchObject({
        applied: true,
        broadcast: !privateSubmission,
        senderSnapshot: privateSubmission,
      });
      expect(store.state.stateVersion).toBe(privateSubmission ? 1 : 2);
      const committed = store.commits.at(-1);
      expect(committed?.game?.rows).toHaveLength(privateSubmission ? 1 : 2);
      expect(committed?.gameDeadlines === undefined).toBe(privateSubmission);
      if (index === 0) {
        expect(committed?.botWork).toEqual({
          cancelActorIds: [actorId],
          upsert: [],
        });
        expect(store.state.controllers.jobs).toEqual(
          scheduled.upsert.filter((job) => job.actorId !== actorId),
        );
      }
      expect(JSON.parse(result.response)).toEqual({
        type: "table/receipt",
        protocolVersion: 1,
        commandId: envelope.commandId,
        outcome: "applied",
        stateVersion: privateSubmission ? 1 : 2,
      });
      if (index === 0) {
        const after = store.game?.state;
        if (after?.schemaVersion !== 1) throw new Error("Expected game");
        expect(projectGameV1(after, observer)).toEqual(before);
        const sequence = after.sequence;
        const retried = await execute(store, actorId, envelope);
        expect(retried).toMatchObject({
          applied: false,
          broadcast: false,
          senderSnapshot: true,
          response: result.response,
        });
        expect(store.game?.state.sequence).toBe(sequence);
      }
    }
    const finished = store.game?.state;
    if (finished?.schemaVersion !== 1) throw new Error("Expected game");
    expect(finished.reactionWindow).toBeNull();
    expect(store.commits).toHaveLength(4);
  });
});
