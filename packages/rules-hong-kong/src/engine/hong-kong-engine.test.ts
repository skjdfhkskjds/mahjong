import { seat, tileId } from "@mahjong/game-core";
import { describe, expect, it } from "vitest";

import type { DeclaredMeld } from "../melds/meld.js";
import { scoringFixture } from "../scoring/scoring-test-fixtures.js";
import {
  actors,
  buildPreDiscardState,
  openDiscard,
  withoutWinningTile,
  withWinningCopy,
} from "./game-test-fixtures.js";
import { hongKongGameEngine } from "./hong-kong-engine.js";
import {
  assertGameInvariants,
  canonicalVersionedGameJson,
  decodeCanonicalVersionedGameJson,
  projectGameV2,
  reduceVersionedGameEvent,
  type CanonicalGameStateV2,
  type PlayerReactionResponse,
} from "./hong-kong-game.js";

type EngineResult = ReturnType<typeof hongKongGameEngine.automate>;
type AcceptedResult = Exclude<EngineResult, { readonly kind: "rejected" }>;

function accepted(
  initial: CanonicalGameStateV2,
  result: EngineResult,
): AcceptedResult {
  if (result.kind === "rejected")
    throw new Error(`Fixture rejected: ${result.error.code}`);
  let replayed = initial;
  for (const event of result.events) {
    const next = reduceVersionedGameEvent(replayed, event);
    if (next.schemaVersion !== 2) throw new Error("Replay lost schema v2.");
    replayed = next;
  }
  expect(replayed).toEqual(result.state);
  expect(
    decodeCanonicalVersionedGameJson(canonicalVersionedGameJson(result.state)),
  ).toEqual(result.state);
  const restored = hongKongGameEngine.lifecycle(result.state);
  const live = result.lifecycle;
  if (restored.phase.kind === "reaction" && live.phase.kind === "reaction") {
    expect({
      ...restored,
      phase: {
        ...restored.phase,
        window: {
          ...restored.phase.window,
          submitted: [...restored.phase.window.submitted].sort(),
        },
      },
    }).toEqual({
      ...live,
      phase: {
        ...live.phase,
        window: {
          ...live.phase.window,
          submitted: [...live.phase.window.submitted].sort(),
        },
      },
    });
  } else {
    expect(restored).toEqual(live);
  }
  assertGameInvariants(result.state);
  return result;
}

function respond(
  state: CanonicalGameStateV2,
  actorId: string,
  response: PlayerReactionResponse,
): AcceptedResult {
  const window = state.reactionWindow;
  if (window === null) throw new Error("Fixture requires a reaction window.");
  return accepted(
    state,
    hongKongGameEngine.execute(state, actorId, {
      type: "game/react",
      windowId: window.id,
      response,
    }),
  );
}

function expire(state: CanonicalGameStateV2): AcceptedResult {
  const target = hongKongGameEngine.deadlineTarget(state);
  if (target === null) throw new Error("Fixture requires a deadline target.");
  return accepted(
    state,
    hongKongGameEngine.expire(state, { target, dueAt: 100 }, 100),
  );
}

function competingWins(): CanonicalGameStateV2 {
  const sourceTileId = tileId(125);
  const west = scoringFixture({
    concealed: "c1 c1 c1 c1 c2 c3 c4 c5 c6 c7 c8 c9 R R",
    source: { type: "discard", sourceSeat: seat("south") },
    winner: seat("west"),
    winningToken: "R",
  });
  const north = withWinningCopy(
    scoringFixture({
      concealed: "b1 b2 b3 b4 b5 b6 b7 b8 b9 E E E R R",
      source: { type: "discard", sourceSeat: seat("south") },
      winner: seat("north"),
      winningToken: "R",
    }),
    tileId(126),
    sourceTileId,
  );
  return openDiscard(
    {
      south: [sourceTileId],
      west: withoutWinningTile(west),
      north: withoutWinningTile(north),
    },
    seat("south"),
    sourceTileId,
  );
}

const pung: DeclaredMeld = {
  claimedTileId: tileId(4),
  exposure: "exposed",
  id: "meld:bamboo-two-pung",
  kind: "pung",
  sourceSeat: seat("east"),
  tileIds: [4, 5, 6].map(tileId),
};

describe("Hong Kong shared engine policy outcomes", () => {
  it("settles a legal self-win and rejects a structurally complete subminimum hand without effects", () => {
    for (const [concealed, legal, exposedChow] of [
      ["c1 c1 c1 c2 c2 c2 c3 c3 c3 c4 c4 c4 R R", true, false],
      ["c4 c5 c6 o1 o2 o3 b7 b8 b9 R R", false, true],
      ["c1 c2 c4 c5 c7 c8 o1 o2 o4 o5 b1 b2 E R", false, false],
    ] as const) {
      const fixture = scoringFixture({
        concealed,
        melds: exposedChow ? [{ kind: "chow", tiles: "c1 c2 c3" }] : [],
        source: { type: "self-pick" },
        winner: seat("west"),
        winningToken: "R",
      });
      const state = buildPreDiscardState({
        lastAcquiredTileId: fixture.winningTileId,
        placements: {
          west: {
            hand: fixture.concealedTileIds,
            melds: fixture.declaredMelds,
          },
        },
        turn: seat("west"),
      });
      const before = canonicalVersionedGameJson(state);
      const result = hongKongGameEngine.execute(state, actors.west, {
        type: "game/declare-win",
      });
      expect(canonicalVersionedGameJson(state)).toBe(before);
      if (!legal) {
        expect(result).toMatchObject({
          kind: "rejected",
          error: { code: "win-not-allowed" },
        });
        expect(result).not.toHaveProperty("events");
        continue;
      }
      const completed = accepted(state, result);
      expect(completed).toMatchObject({
        kind: "resolved",
        result: { kind: "self-win", result: completed.state.result },
        trigger: { kind: "move", actorId: actors.west },
      });
      expect(completed.events.map(({ type }) => type)).toEqual([
        "game/self-win-declared",
        "game/hand-completed",
      ]);
      expect(hongKongGameEngine.deadlineTarget(completed.state)).toBeNull();
    }
  });

  it("keeps legal pending wins private and accepts a losing legal claimant as the final response", () => {
    const initial = competingWins();
    const target = hongKongGameEngine.deadlineTarget(initial);
    const north = respond(initial, actors.north, { type: "win" });
    expect(north).toMatchObject({
      kind: "pending",
      visibility: "private",
      submission: { seat: "north", response: { type: "win" } },
      state: { result: null },
    });
    expect(north).not.toHaveProperty("result");
    expect(hongKongGameEngine.deadlineTarget(north.state)).toEqual(target);
    for (const viewer of [
      actors.east,
      actors.south,
      actors.west,
      "spectator",
    ]) {
      expect(projectGameV2(north.state, viewer)).toEqual(
        projectGameV2(initial, viewer),
      );
    }
    const passed = respond(north.state, actors.east, { type: "pass" });
    const final = respond(passed.state, actors.west, { type: "win" });
    expect(final).toMatchObject({
      kind: "resolved",
      trigger: {
        kind: "response",
        actorId: actors.west,
        submission: { seat: "west", response: { type: "win" } },
      },
      result: {
        kind: "reaction",
        outcome: {
          kind: "hand-won",
          result: final.state.result,
          claimants: [
            { seat: "west", award: "not-awarded" },
            { seat: "north", award: "awarded" },
          ],
        },
      },
    });
    expect(final.state.result).toMatchObject({
      winnerSeat: "north",
      cappedFaan: 6,
    });
    expect(final.events.map(({ type }) => type)).toEqual([
      "game/reaction-intent-submitted",
      "game/reaction-resolved",
      "game/hand-completed",
    ]);
    const publicResult = JSON.stringify(
      projectGameV2(final.state, "spectator"),
    );
    expect(publicResult).not.toContain("claimants");
    expect(publicResult).not.toContain("not-awarded");
    expect(publicResult).not.toContain('"cappedFaan":5');
  });

  it("resolves recorded wins at expiry with the same result as a final pass", () => {
    const initial = competingWins();
    const north = respond(initial, actors.north, { type: "win" });
    const west = respond(north.state, actors.west, { type: "win" });
    const timed = expire(west.state);
    const final = respond(west.state, actors.east, { type: "pass" });
    expect(timed).toMatchObject({
      kind: "resolved",
      trigger: { kind: "expiry" },
    });
    if (timed.kind !== "resolved" || final.kind !== "resolved")
      throw new Error("Win did not resolve.");
    expect(timed.result).toEqual(final.result);
    expect(timed.state.result).toEqual(final.state.result);
    expect(timed.events.map(({ type }) => type)).toEqual([
      "game/reaction-resolved",
      "game/hand-completed",
    ]);
  });

  it("rejects an illegal win without recording a response or consuming the next pass", () => {
    const fixture = scoringFixture({
      concealed: "c1 c2 c3 c4 c5 c6 o1 o2 o3 b7 b8 b9 R R",
      source: { type: "discard", sourceSeat: seat("south") },
      winner: seat("west"),
      winningToken: "R",
    });
    const state = openDiscard(
      { south: [fixture.winningTileId], west: withoutWinningTile(fixture) },
      seat("south"),
      fixture.winningTileId,
    );
    expect(
      hongKongGameEngine.execute(state, actors.west, {
        type: "game/react",
        response: { type: "win" },
        windowId: state.reactionWindow?.id ?? "missing",
      }),
    ).toMatchObject({ kind: "rejected", error: { code: "win-not-allowed" } });
    expect(respond(state, actors.west, { type: "pass" }).kind).toBe("pending");
  });

  it("normalizes missing responses to all-pass and advances the ordinary turn", () => {
    const state = openDiscard({ east: [tileId(4)] }, seat("east"), tileId(4));
    const result = expire(state);
    expect(result).toMatchObject({
      kind: "resolved",
      result: { kind: "reaction", outcome: { kind: "all-pass" } },
      state: { turn: "south", phase: "awaiting-draw" },
    });
    const resolution = result.events[0];
    expect(resolution).toMatchObject({
      type: "game/reaction-resolved",
      responses: [
        { seat: "south", response: { type: "pass" } },
        { seat: "west", response: { type: "pass" } },
        { seat: "north", response: { type: "pass" } },
      ],
    });
  });

  it.each([
    {
      response: { type: "chow", handTileIds: [tileId(0), tileId(8)] } as const,
      claimant: "south" as const,
    },
    {
      response: { type: "pung", handTileIds: [tileId(5), tileId(6)] } as const,
      claimant: "west" as const,
    },
  ])(
    "reports a selected $response.type with its active claimant",
    ({ response, claimant }) => {
      const state = openDiscard(
        {
          east: [tileId(4)],
          south: [tileId(0), tileId(8)],
          west: [tileId(5), tileId(6)],
        },
        seat("east"),
        tileId(4),
      );
      const intent = respond(state, actors[claimant], response);
      const result = expire(intent.state);
      expect(result).toMatchObject({
        kind: "resolved",
        result: {
          kind: "reaction",
          outcome: { kind: "meld-claimed", seat: claimant, response },
        },
        state: { turn: claimant, phase: "awaiting-discard" },
      });
      expect(result.state.players[claimant].melds.at(-1)).toMatchObject({
        kind: response.type,
      });
    },
  );

  it.each([135, 136])(
    "reports concealed, claimed, and added-kong replacement results for last tile %s",
    (lastTile) => {
      const exhausted = lastTile === 136;
      const replacement = {
        kind: exhausted ? "exhausted" : "drawn",
        tileIds: [tileId(lastTile)],
      };
      const concealed = buildPreDiscardState({
        lastAcquiredTileId: tileId(3),
        placements: { east: { hand: [0, 1, 2, 3].map(tileId) } },
        turn: seat("east"),
        wallFinalTileId: tileId(lastTile),
      });
      const declared = accepted(
        concealed,
        hongKongGameEngine.execute(concealed, actors.east, {
          type: "game/declare-concealed-kong",
          tileIds: [tileId(0), tileId(1), tileId(2), tileId(3)],
        }),
      );
      expect(declared).toMatchObject({
        kind: "applied",
        outcome: {
          kind: "concealed-kong",
          meld: declared.state.players.east.melds[0],
          replacement,
        },
      });

      const beforeDiscard = buildPreDiscardState({
        lastAcquiredTileId: tileId(4),
        placements: {
          east: { hand: [tileId(4)] },
          west: { hand: [5, 6, 7].map(tileId) },
        },
        turn: seat("east"),
        wallFinalTileId: tileId(lastTile),
      });
      const discarded = accepted(
        beforeDiscard,
        hongKongGameEngine.execute(beforeDiscard, actors.east, {
          type: "game/discard",
          tileId: tileId(4),
        }),
      );
      expect(discarded).toMatchObject({
        kind: "applied",
        outcome: {
          kind: "discarded",
          tileId: 4,
          windowId: discarded.state.reactionWindow?.id,
        },
      });
      const claimed = respond(discarded.state, actors.west, {
        type: "kong",
        handTileIds: [tileId(5), tileId(6), tileId(7)],
      });
      const exposed = expire(claimed.state);
      expect(exposed).toMatchObject({
        kind: "resolved",
        result: {
          kind: "reaction",
          outcome: { kind: "kong-claimed", seat: "west", replacement },
        },
      });

      const beforeAdded = buildPreDiscardState({
        lastAcquiredTileId: tileId(7),
        placements: { south: { hand: [tileId(7)], melds: [pung] } },
        turn: seat("south"),
        wallFinalTileId: tileId(lastTile),
      });
      const proposed = accepted(
        beforeAdded,
        hongKongGameEngine.execute(beforeAdded, actors.south, {
          type: "game/propose-added-kong",
          meldId: pung.id,
          tileId: tileId(7),
        }),
      );
      expect(proposed).toMatchObject({
        kind: "applied",
        outcome: {
          kind: "added-kong-proposed",
          meldId: pung.id,
          tileId: 7,
          windowId: proposed.state.reactionWindow?.id,
        },
      });
      const added = expire(proposed.state);
      expect(added).toMatchObject({
        kind: "resolved",
        result: {
          kind: "reaction",
          outcome: { kind: "added-kong-completed", seat: "south", replacement },
        },
      });
      expect(added.state.players.south.melds[0]).toMatchObject({
        id: pung.id,
        kongKind: "added",
      });
      for (const result of [declared, exposed, added]) {
        expect(result.state.phase).toBe(
          exhausted ? "exhausted" : "awaiting-discard",
        );
        expect(result.events.at(-1)).toMatchObject({
          type: "game/kong-replacement-drawn",
          exhausted,
          tileIds: replacement.tileIds,
        });
        expect(hongKongGameEngine.deadlineTarget(result.state) === null).toBe(
          exhausted,
        );
      }
    },
  );

  it("distinguishes last structural draw success, ordinary exhaustion, and bonus replacement exhaustion", () => {
    for (const lastTile of [135, 136]) {
      const state = buildPreDiscardState({
        lastAcquiredTileId: null,
        placements: {},
        turn: seat("south"),
        phase: "awaiting-draw",
        wallFinalTileId: tileId(lastTile),
      });
      const drawn = accepted(
        state,
        hongKongGameEngine.execute(state, actors.south, { type: "game/draw" }),
      );
      if (lastTile === 136) {
        expect(drawn).toMatchObject({
          kind: "applied",
          outcome: { kind: "exhausted", requiredDraw: "bonus-replacement" },
          state: { phase: "exhausted" },
        });
        continue;
      }
      expect(drawn).toMatchObject({
        kind: "applied",
        outcome: { kind: "drawn", ordinaryTileId: 135, replacementTileIds: [] },
        state: { phase: "awaiting-discard" },
      });
      const discarded = accepted(
        drawn.state,
        hongKongGameEngine.execute(drawn.state, actors.south, {
          type: "game/discard",
          tileId: tileId(lastTile),
        }),
      );
      const passed = expire(discarded.state);
      const exhausted = accepted(
        passed.state,
        hongKongGameEngine.execute(passed.state, actors.west, {
          type: "game/draw",
        }),
      );
      expect(exhausted).toMatchObject({
        kind: "applied",
        outcome: { kind: "exhausted", requiredDraw: "ordinary" },
        state: { phase: "exhausted" },
      });
      expect(exhausted.events).toHaveLength(1);
    }
  });

  it("preserves recursive ordinary and kong replacement effects in their typed outcomes", () => {
    const state = buildPreDiscardState({
      lastAcquiredTileId: null,
      placements: {},
      phase: "awaiting-draw",
      turn: seat("south"),
      liveWallTileIds: [136, 135, 137].map(tileId),
    });
    const drawn = accepted(
      state,
      hongKongGameEngine.execute(state, actors.south, { type: "game/draw" }),
    );
    expect(drawn).toMatchObject({
      kind: "applied",
      outcome: {
        kind: "drawn",
        ordinaryTileId: 136,
        replacementTileIds: [137, 135],
      },
      state: { phase: "awaiting-discard" },
    });
    expect(drawn.events[0]).toMatchObject({
      type: "game/turn-drawn",
      ordinaryTileId: 136,
      replacementTileIds: [137, 135],
      exhausted: false,
    });
    expect(drawn.state.players.south.bonuses).toEqual([
      tileId(136),
      tileId(137),
    ]);

    const kong = buildPreDiscardState({
      lastAcquiredTileId: tileId(3),
      placements: { east: { hand: [0, 1, 2, 3].map(tileId) } },
      turn: seat("east"),
      liveWallTileIds: [135, 137, 136].map(tileId),
    });
    const declared = accepted(
      kong,
      hongKongGameEngine.execute(kong, actors.east, {
        type: "game/declare-concealed-kong",
        tileIds: [tileId(0), tileId(1), tileId(2), tileId(3)],
      }),
    );
    expect(declared).toMatchObject({
      kind: "applied",
      outcome: {
        kind: "concealed-kong",
        replacement: { kind: "drawn", tileIds: [136, 137, 135] },
      },
    });
    expect(declared.events.at(-1)).toMatchObject({
      type: "game/kong-replacement-drawn",
      tileIds: [136, 137, 135],
      exhausted: false,
    });
  });

  it("awards a robbed added-kong win without committing the proposed kong", () => {
    const state = buildPreDiscardState({
      lastAcquiredTileId: tileId(7),
      turn: seat("south"),
      placements: {
        south: { hand: [tileId(7)], melds: [pung] },
        west: {
          hand: [0, 8, 36, 37, 38, 40, 41, 42, 44, 45, 46, 108, 109].map(
            tileId,
          ),
        },
      },
    });
    const proposed = accepted(
      state,
      hongKongGameEngine.execute(state, actors.south, {
        type: "game/propose-added-kong",
        meldId: pung.id,
        tileId: tileId(7),
      }),
    );
    const claimed = respond(proposed.state, actors.west, { type: "win" });
    const result = expire(claimed.state);
    expect(result).toMatchObject({
      kind: "resolved",
      result: {
        kind: "reaction",
        outcome: {
          kind: "hand-won",
          result: result.state.result,
          claimants: [{ seat: "west", award: "awarded" }],
        },
      },
    });
    expect(result.state.result).toMatchObject({
      winnerSeat: "west",
      source: { type: "robbing-kong", sourceSeat: "south" },
    });
    expect(result.state.players.south.melds[0]).toEqual(pung);
    expect(result.state.players.south.hand).not.toContain(tileId(7));
    expect(result.state.players.west.hand).toContain(tileId(7));
    expect(result.events.map(({ type }) => type)).toEqual([
      "game/reaction-resolved",
      "game/hand-completed",
    ]);
  });

  it("rejects early and stale logical expiry while preserving the original target across private responses", () => {
    const state = openDiscard({ east: [tileId(4)] }, seat("east"), tileId(4));
    const target = hongKongGameEngine.deadlineTarget(state);
    if (target === null) throw new Error("Expected reaction deadline.");
    const deadline = { target, dueAt: 100 };
    const pending = respond(state, actors.south, { type: "pass" });
    expect(hongKongGameEngine.deadlineTarget(pending.state)).toEqual(target);
    expect(
      hongKongGameEngine.expire(pending.state, deadline, 99),
    ).toMatchObject({ kind: "rejected", error: { code: "expiry-not-due" } });
    const resolved = hongKongGameEngine.expire(pending.state, deadline, 100);
    if (resolved.kind !== "resolved")
      throw new Error("Expiry did not resolve.");
    accepted(pending.state, resolved);
    expect(
      hongKongGameEngine.expire(resolved.state, deadline, 101),
    ).toMatchObject({ kind: "rejected", error: { code: "stale-expiry" } });
    expect(hongKongGameEngine.expire(pending.state, deadline, 101)).toEqual(
      resolved,
    );
  });

  it("retains draw and discard outcomes together when an expired turn runs automatically", () => {
    const state = buildPreDiscardState({
      lastAcquiredTileId: null,
      placements: {},
      phase: "awaiting-draw",
      turn: seat("south"),
      liveWallTileIds: [136, 135, 137].map(tileId),
    });
    const result = expire(state);
    expect(result.kind).toBe("automated");
    if (result.kind !== "automated")
      throw new Error("Timeout did not retain its steps.");
    expect(result.steps).toHaveLength(2);
    const [drawn, discarded] = result.steps;
    expect(drawn).toMatchObject({
      kind: "applied",
      outcome: {
        kind: "drawn",
        ordinaryTileId: 136,
        replacementTileIds: [137, 135],
      },
    });
    expect(discarded).toMatchObject({
      kind: "applied",
      outcome: { kind: "discarded", tileId: 135 },
    });
    expect(result.events).toEqual([...drawn.events, ...discarded.events]);
    expect(result.state).toEqual(discarded.state);
    expect(result.state.players.south.discards).toEqual([tileId(135)]);
    expect(result.state.phase).toBe("awaiting-discard-reactions");
    expect(hongKongGameEngine.automate(state, actors.south)).toEqual(result);
    const pass = accepted(
      result.state,
      hongKongGameEngine.automate(result.state, actors.west),
    );
    expect(pass).toMatchObject({
      kind: "pending",
      submission: { seat: "west", response: { type: "pass" } },
    });
  });
});
