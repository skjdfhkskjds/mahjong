# Milestones 5–6 implementation plan

Status: frozen

Frozen: 2026-09-01

Scope: claims, kongs, operational deadlines, winning-hand recognition, scoring,
single-winner selection, and per-hand payment explanations for
`hong-kong/v1`.

This document is the implementation contract for Milestones 5 and 6. A change
to a selected rules outcome must update the decision register, worked examples,
traceability fixtures, and this plan before code relies on it. Implementation
details may be refined without reopening the plan only when all fixtures and
observable outcomes remain unchanged.

## GO decision and release boundary

Implement Milestones 5 and 6 as one deployable sequence. Milestone 5 may
temporarily model a structurally eligible win intention while pure engine work
is in progress, but no release or milestone-complete claim may leave a table in
an `awaiting-win-validation` dead end. The finished vertical slice must offer a
win only after the full Milestone 6 scorer proves that the hand meets the
three-faan minimum, and every accepted win must finish the hand with one winner,
an explanation, and zero-sum payment deltas.

The slice does not start another hand or maintain match balances. Milestone 7
owns dealer continuation, round advancement, cumulative balances, history
retention/compaction, and the next-hand command.

## Pinned provenance

The project uses the following fixed source revisions as provenance, not the
mutable current pages:

- [Mahjong gameplay and Old Hong Kong rules, revision 1371716881](https://en.wikipedia.org/w/index.php?title=Mahjong&oldid=1371716881)
- [Hong Kong mahjong scoring rules, revision 1370049011](https://en.wikipedia.org/w/index.php?title=Hong_Kong_mahjong_scoring_rules&oldid=1370049011)

Wikipedia describes multiple table conventions and the scoring article carries
an accuracy-dispute notice. The explicit project selections below therefore
take precedence whenever those pages are silent, internally inconsistent, or
list alternatives.

The deadline design also relies on current primary platform documentation:

- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Cloudflare Durable Object rules and lifecycle](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Cloudflare supplies one alarm per Durable Object and documents at-least-once
alarm delivery with bounded automatic retries. Consequently, the alarm is only
a wake-up signal; persisted deadlines and idempotent system commands are the
authority.

## Accepted gameplay semantics

### Reactions

- Every discard opens one reaction window for the three other seats. Every seat
  is a responder even if its only legal response is pass; this prevents the
  public timing of the window from revealing concealed eligibility.
- A response applies only to the current window and its opening room revision.
  The first valid response from a seat is final. A malformed or illegal response
  is rejected without consuming that seat's opportunity to submit a valid one.
- A missing response becomes pass at the reaction deadline.
- Resolve when all three seats have responded or at the deadline. Resolution
  order never depends on submission arrival order.
- Priority is win, then pung or exposed kong at equal priority, then chow.
  Tile conservation means competing pung/kong claimants cannot exist for one
  discard. One claimant that holds three matching tiles may choose pung instead
  of kong.
- If more than one legal win response exists, score every candidate, select the
  highest capped total faan, and then select the nearest candidate in normal
  turn order after the source seat. There is exactly one winner.
- Only the next seat in turn order may chow. A chow is exactly three consecutive
  suited kinds in one suit; honors and bonuses cannot chow. When more than one
  sequence is possible, each exact pair of physical hand tile IDs is a distinct
  private legal action.
- A pass creates no continuing passed-win or furiten-style restriction. It
  expires with the current window.
- A forged illegal win/claim is rejected. Because the authoritative server does
  not broadcast an invalid declaration, `hong-kong/v1` applies no false-win
  payment penalty.

### Melds and kongs

- Public melds are immutable and carry a stable meld ID, exact physical tile
  IDs, the claimed tile ID when any, the source seat when any, and exposure.
- Chow and pung claims move the most recent discard into the claimant's meld,
  make the claimant active, skip intervening seats, and require a discard
  without an ordinary head draw.
- Support concealed kong, exposed kong claimed from a discard, and added kong
  upgrading an exposed pung with a concealed matching tile.
- A concealed kong may be declared during the active player's pre-discard phase,
  including East's opening phase. It does not make the hand exposed for scoring.
- An exposed kong is a discard reaction and competes at pung priority below a
  win.
- An added kong first opens a robbing window. Only an added kong may be robbed,
  and any otherwise legal winning structure may use the tile. If robbed, the
  pung remains a pung and the fourth tile moves to the winner. If not robbed,
  the pung becomes an added kong.
- Every committed kong draws a replacement from the existing v1 wall tail.
  Bonus replacements recurse from the tail. A player may declare another kong
  before discarding.
- If a committed kong's required replacement chain cannot produce a structural
  tile, the kong remains committed and the hand exhausts. All physical tiles
  remain conserved.
- A meld has structural size three even when it is a four-tile kong. The core
  hand-size invariant is `concealed tile count + 3 × meld count`: 13 between
  turns and 14 before a discard or win.

### Winning structures

The scorer enumerates every legal standard decomposition after fixed declared
melds. A standard hand is four melds and one pair. Chows use suited consecutive
kinds; pungs and kongs use identical kinds. Exact physical IDs are assigned
deterministically after kind-level decomposition.

Two nonstandard structures are enabled:

- Seven pairs: seven pairs of seven distinct tile kinds, no declared melds.
  Every participating kind has exactly two concealed copies; four copies of one
  kind cannot form two pairs, and a declared kong cannot participate.
- Thirteen orphans: one of every terminal and honor kind plus one duplicate of
  any of those kinds, with no declared meld.

For each structural interpretation, scoring is computed independently. The
highest legal score wins. Equal scores choose the canonical awarded-pattern ID
list and then the canonical decomposition encoding, solely to keep replay bytes
stable.

## Scoring catalog

### Ordinary hand patterns

| Stable ID        | Faan | Selection                                                                   |
| ---------------- | ---: | --------------------------------------------------------------------------- |
| `common-hand`    |    1 | Every one of the four melds is a chow.                                      |
| `all-triplets`   |    3 | Every meld is a pung or kong.                                               |
| `mixed-one-suit` |    3 | Honors plus tiles from exactly one suit; requires both an honor and a suit. |
| `all-one-suit`   |    7 | Every structural tile belongs to exactly one suit; no honors.               |
| `mixed-orphans`  |    1 | Only terminal/honor pungs or kongs plus a terminal/honor pair.              |
| `small-dragons`  |    5 | Two dragon melds and a pair of the third dragon.                            |
| `great-dragons`  |    8 | Melds of all three dragons.                                                 |
| `small-winds`    |    6 | Three wind melds and a pair of the fourth wind.                             |
| `seven-pairs`    |    4 | The selected special structure above.                                       |

`mixed-orphans` stacks with `all-triplets`. `all-one-suit` excludes
`mixed-one-suit`. The source wording for dragon hands is ambiguous about whether
individual dragon-meld faan are additional; v1 treats 5 and 8 as the complete
dragon awards and suppresses the corresponding individual dragon awards.
`small-winds` may still stack with seat/prevailing wind and suit awards as the
source explicitly describes.

### Limit hand patterns

| Stable ID                 | Faan | Selection                                                                      |
| ------------------------- | ---: | ------------------------------------------------------------------------------ |
| `all-honors`              |   10 | Every structural tile is a wind or dragon.                                     |
| `four-concealed-triplets` |   10 | Four concealed pungs/concealed kongs; a discard may complete only the pair.    |
| `terminals-only`          |   10 | Only terminal pungs/kongs and a terminal pair.                                 |
| `nine-gates`              |   10 | No declared meld; one suit containing `1112345678999` plus any same-suit tile. |
| `great-winds`             |   13 | Melds of all four winds.                                                       |
| `four-kongs`              |   13 | Four declared kongs plus a pair.                                               |
| `thirteen-orphans`        |   13 | The selected special structure above.                                          |

If any limit hand is detected, award only the highest-valued limit hand plus an
eligible winning-condition award, then cap at 13. Suppress ordinary hand,
wind/dragon, and bonus awards. This follows the source's general limit rule even
though its Seven Pairs row separately says Seven Pairs can stack with All
Honors. The contradiction is resolved in favor of limit supersession.

### Wind, dragon, and bonus awards

- A pung or kong of the winner's seat wind awards 1 faan.
- A pung or kong of the prevailing wind awards 1 faan. A double wind awards
  both. The first hand's prevailing wind is East; Milestone 7 owns advancement.
- A pung or kong of red, green, or white dragon awards 1 faan unless suppressed
  by Small/Great Dragons or a limit hand.
- No bonus tiles awards 1 bonus faan.
- The matching flower and matching season each award 1 bonus faan.
- All four flowers award 2 and suppress matching-flower faan. All four seasons
  award 2 and suppress matching-season faan.
- Custom instant wins for seven or eight bonus tiles are excluded.

All bonus-category faan, including no bonuses, are excluded from the minimum
needed to declare a win. They are added only after eligibility succeeds.

### Winning-condition awards

| Stable ID         | Faan | Selection                                                                   |
| ----------------- | ---: | --------------------------------------------------------------------------- |
| `self-pick`       |    1 | Winning structural tile came from the wall.                                 |
| `fully-concealed` |    1 | No exposed meld; a final discard may be claimed.                            |
| `robbing-kong`    |    1 | Win uses the proposed fourth tile of an added kong.                         |
| `last-catch`      |    1 | Win uses the final wall tile or its immediately following discard.          |
| `replacement-win` |    1 | Win uses a structural replacement after a kong or bonus; also self-pick.    |
| `double-kong-win` |    8 | A kong replacement formed another kong and its replacement wins; self-pick. |
| `heavenly-hand`   |   13 | East wins before the opening discard.                                       |
| `earthly-hand`    |   13 | A non-East seat wins on East's first discard before East made a kong.       |

Initial bonus replacement does not disqualify Heavenly or Earthly Hand.
`double-kong-win` suppresses `replacement-win` but still awards `self-pick`.
Seven Pairs, Thirteen Orphans, Four Concealed Triplets, and Nine Gates suppress
the generic `fully-concealed` award. Heavenly and Earthly Hand suppress other
winning-condition awards for a stable explanation; the 13-faan cap makes the
numeric result equivalent.

### Minimum, cap, and payments

- A legal win requires at least 3 eligibility faan from hand, wind/dragon, and
  winning-condition categories. Bonus faan do not help meet the minimum.
- After eligibility, add allowed bonus faan and cap total faan at 13.
- Use the Half Spicy table: `3→8`, `4→16`, `5→24`, `6→32`, `7→48`, `8→64`,
  `9→96`, `10→128`, `11→192`, `12→256`, `13→384` points.
- On discard or robbing-kong wins, the source seat pays all table points; the
  other two seats pay zero.
- On self-pick, every loser pays half the table points and the winner receives
  one and a half times the table amount. Every payment vector sums to zero.
- No dealer multiplier, immediate kong payment, responsibility/pao transfer, or
  running balance is applied in v1.

## Canonical rules state and event contract

### State schema v2

Canonical state schema v2 retains the v1 wall, players, ruleset, shuffle
algorithm, sequence, turn, and phase and adds:

- declared melds on each player;
- a reaction window with its public source and authority-only, actor-keyed
  submitted intents while it is open;
- East prevailing wind for the first hand;
- turn provenance sufficient to decide Heavenly/Earthly, last catch,
  replacement win, and double-kong win without ambient history;
- terminal `complete` result containing one winner, source, winning
  decomposition, detected/awarded/suppressed patterns, eligibility/bonus/raw/
  capped faan, table points, zero-sum payments, and structured explanation;
- an `exhausted` terminal state for unavailable required draws.

Private reaction intents are canonical rules state so their sequence, hash, and
replay are authoritative. Room lifecycle, deadline scheduling, connection
presence, and autopilot status remain operational `TableRoom` state rather than
Hong Kong scoring state.

### Phases

The deployable state machine is:

```text
awaiting-dealer-discard
awaiting-draw
awaiting-discard
awaiting-discard-reactions
awaiting-added-kong-reactions
complete
exhausted
```

An implementation-only provisional validation phase must not appear in the
final protocol or persisted deployable state.

### Player commands

Protocol v2 supports:

```text
game/start
game/draw
game/discard(tileId)
game/react(windowId, pass)
game/react(windowId, chow(handTileIds[2]))
game/react(windowId, pung(handTileIds[2]))
game/react(windowId, kong(handTileIds[3]))
game/react(windowId, win)
game/declare-concealed-kong(tileIds[4])
game/propose-added-kong(meldId, tileId)
game/declare-win
```

The engine validates exact physical IDs. The client never submits an inferred
kind-only meld. `game/declare-win` is a self-action for dealer-initial,
self-pick, and replacement wins; reaction `win` covers discard and robbing.

Every player command uses the closed envelope:

```text
{
  type: "table/command",
  protocolVersion: 2,
  commandId: bounded opaque string,
  expectedStateVersion: nonnegative integer,
  command: one command payload above
}
```

Every reaction command includes the current `windowId`; exact meld tile arrays
are canonical ascending physical-ID order. The server rejects unknown fields,
duplicate IDs, a command/window kind mismatch, and a stale opening version.

### System commands

Every due deadline becomes one explicit command with a stable deadline ID:

```text
system/reaction-expired(windowId, openingSequence)
system/turn-expired(seat, phase, openingSequence)
system/disconnect-grace-expired(actorId, connectionGeneration)
system/table-abandonment-expired(roomActivityGeneration)
```

Stale target generation/sequence, an already-processed receipt, or an already
closed phase makes the command an idempotent no-op. Alarm handlers never edit
game or room state directly.

### Canonical events

The event union retains v1 events for historical replay and adds events for:

- explicit v1-to-v2 state upgrade;
- discard reaction opening;
- authority-only `game/reaction-intent-submitted` with the actor's normalized
  valid response;
- normalized reaction resolution;
- concealed kong and replacement outcome;
- added-kong proposal and resolution;
- self-declared win and scored hand completion;
- wall exhaustion for ordinary, bonus, or kong replacement draws.

`game/reaction-intent-submitted` advances canonical game sequence, event hash,
checkpoint, and v2 reaction state. It is authority-only: it does not increment
public room `stateVersion`, trigger a broadcast, or reveal that any other seat
responded. `game/reaction-resolved` contains all three normalized responses in
fixed turn order, inserting pass for a missing timeout response. This
server-only payload lets replay independently prove that the selected outcome
obeyed priority and scoring rather than trusting a preselected winner. Losing
choices and both event types' hashes never cross the live viewer boundary.

Accepted pure command application returns a nonempty ordered event batch, not
an optional side-channel write. The authority assigns contiguous sequences,
hashes, and reducer states event by event and persists the full batch plus its
final checkpoint and command receipt in one transaction. A one-event private
submission is therefore recovered and verified by the same replay path as every
public transition. If any event, receipt, deadline, or checkpoint write fails,
none of the batch commits and nothing is published.

## Persistence and migration

### TableRoom storage schema v4

Schema v4 adds responsibility-based tables:

- `deadlines`: stable ID, kind, due time, exact validated payload, target
  generation, status, and processed time;
- `system_command_receipts`: stable command ID, canonical request, result, and
  processing time;
- operational room/player state for lifecycle generation and autopilot status.

Canonical v2 game state and its event chain are the sole authority for reaction
windows and submitted intents. A SQL reaction index may be introduced only if
it is derived from, verified against, and rebuildable from the canonical
checkpoint and events; it cannot be a second authority. The initial
implementation omits reaction tables. Indexes cover the earliest pending
`(due_at, deadline_id)`. Unknown schema versions and incoherent deadline/state
pairs fail closed. The planned relational contract is:

```text
deadlines(
  deadline_id PRIMARY KEY,
  kind CHECK reaction|turn|disconnect|abandonment,
  due_at,
  target_generation,
  payload_json,
  status CHECK pending|processed|cancelled,
  processed_at NULL
)

system_command_receipts(
  command_id PRIMARY KEY,
  request_json,
  result_json,
  processed_at
)
```

Exact integer bounds, foreign keys achievable in Durable Object SQLite, JSON
decoders, and indexes are part of the migration implementation. Private command
JSON is never logged or returned to a different actor.

### Canonical upgrade and hashes

Never reinterpret canonical schema-v1 bytes as v2. On wake:

1. Transactionally migrate SQLite v1/v2/v3 to v4.
2. Verify the complete stored hash chain and v1 checkpoint using the existing
   v1 decoder/reducer.
3. If a v1 game exists, create a deterministic `game/state-upgraded` event,
   hash it using the existing canonical hash payload version, append it, and
   write the canonical v2 checkpoint atomically.
4. Verify replay through the upgrade is byte-equivalent to the checkpoint.
5. Recover the earliest pending deadline without overwriting an already earlier
   platform alarm.

The upgrade is authority-only and does not increment viewer `stateVersion` when
its projection is unchanged. Fresh games begin directly with state schema v2.
The canonical JSON ordering and SHA-256 hash payload remain version 1; state
schema versioning changes shape without rewriting earlier hashes.

Permanent fixtures must include the oldest TableRoom v1 schema and a TableRoom
v3 fixture containing a live canonical state-v1 game and hash chain. Recovery
must prove both migration roots, event replay, projection equivalence, and
continued play.

## Private reaction protocol and protocol v2

Reaction intents are canonical, durable authority state but are not public room
transitions. A valid intent:

- targets the window and its opening room version;
- appends `game/reaction-intent-submitted`, advances canonical game sequence,
  event hash, checkpoint, and v2 reaction state, and writes the actor-scoped
  receipt atomically;
- does not increment public room `stateVersion`;
- does not broadcast or expose submission counts;
- returns a private receipt and may return a sender-only fresh snapshot;
- survives eviction and reconnect; the submitting viewer sees only their own
  final response status.

Resolution increments public room `stateVersion` once. When the third response
both submits and resolves, one transaction appends the ordered event batch
`[game/reaction-intent-submitted, game/reaction-resolved]`, advances the hash
chain and checkpoint through both events, stores one receipt with the resulting
public version, updates deadlines, and publishes only the resolved snapshot.
An earlier non-resolving response appends only the private intent event and its
receipt retains the opening public version.

Protocol v2 is selected because commands, phases, melds, legal actions,
deadlines, and result views are incompatible additions to the strict v1 wire
schema. There has been no external deployment, so there is no supported mixed
client window and no dual-reading implementation. The client requests v2 with
`/api/table/socket?protocolVersion=2`; absence, version 1, or any unsupported
major is rejected with an upgrade-required control frame and dedicated close
code before gameplay messages are accepted. The query selects representation
only and grants no authority. Client and Worker deploy atomically, with the
Activity shell referring to content-hashed client assets; rollback restores
both halves together. Historical protocol-v1 fixtures remain documentation of
the old contract, not live wire support.

### Viewer-safe game view

The closed v2 snapshot envelope remains:

```text
{
  type: "table/snapshot",
  protocolVersion: 2,
  stateVersion,
  view: {
    phase: lobby|playing|complete|exhausted|abandoned,
    tableId,
    seats,
    spectators,
    viewer,
    game?: {
      phase,
      turn,
      wallRemaining,
      deadlineAt: integer|null,
      reaction?: { windowId, kind, sourceSeat, sourceTile, sourceMeldId? },
      players: [{ seat, concealedCount, bonuses, discards, melds } × 4],
      viewerHand?: tiles,
      viewerActions?: {
        self: exact actions,
        reaction?: { windowId, status: open|submitted, actions }
      },
      result?: structured scored result
    }
  }
}
```

The receipt envelope retains `commandId`, applied/rejected outcome,
`stateVersion`, and a stable error code/message at protocol version 2. An
`upgrade-required` control frame contains only protocol version and the minimum
supported version before closing with the dedicated protocol-upgrade close
code. Exact close code selection is transport-level and may be chosen during
implementation without changing rules fixtures.

All viewers may receive:

- public phase, turn, wall count, deadline, discards, bonuses, declared melds,
  and public reaction source;
- public automation/abandonment status;
- on completion, the winning hand/decomposition and structured score/payment
  explanation.

A seated viewer additionally receives:

- their own concealed hand;
- exact legal self-actions;
- during a reaction window, exact legal reaction actions and only their own
  response status.

No viewer receives opponent legal-action eligibility, response status, losing
win scores, concealed tiles, canonical events, wall order, event hashes, or raw
deadline/system receipts. Spectators receive no concealed hand or private
actions. Noninterference tests alter opponent hands and intents while requiring
all unauthorized fields and bytes to remain unchanged.

## Operational deadlines and races

Selected defaults:

| Deadline                      | Duration | Outcome                                                                     |
| ----------------------------- | -------: | --------------------------------------------------------------------------- |
| Connected turn decision       |     60 s | Perform the deterministic phase action described below.                     |
| Reaction                      |      8 s | Missing responses normalize to pass, then resolve.                          |
| Zero-valid-socket disconnect  |     15 s | Mark actor autopilot and immediately perform actionable deterministic work. |
| Table-wide zero valid sockets |     15 m | Mark room/hand recoverably abandoned; retain all storage and history.       |

Every transition into a connected player's new draw or discard decision starts
a fresh 60-second turn deadline. This deadline is independent of the 15-second
disconnect grace; the grace does not replace or shorten the connected decision
timer. Presence is derived from sockets whose attachment, session, grant,
actor/instance generation, and table binding are all valid at evaluation time.
A stored connection grant alone never establishes presence.

When an actor reaches the disconnect grace, the canonical/system-command
pipeline marks that actor autopilot and immediately performs any currently
actionable deterministic work. Future autopilot turns act immediately:

- in `awaiting-draw`, atomically draw from the head, recursively take all
  required tail replacements, and discard the last-acquired structural tile;
  if the required draw chain exhausts, end the hand as exhausted;
- in `awaiting-discard`, discard the last-acquired tile that remains concealed,
  or the lowest canonical physical tile ID when no such tile remains;
- in a reaction window, submit canonical pass for any outstanding response and
  resolve when that makes the window complete.

The same draw/replacement/discard compound action is performed by a 60-second
turn timeout. Autopilot and timeouts never declare a win or kong. A newly valid
seated socket advances the connection generation, cancels stale disconnect
work, and clears that actor's autopilot status; it does not undo already
committed automatic events. Marking or clearing public autopilot/abandonment
status is one viewer-visible room transition and increments public room
`stateVersion` once; mere socket churn still does not. After 15 minutes with no
valid socket anywhere at the table, mark the room/hand abandoned without
deletion. A later valid seated reconnect clears abandonment and resumes from
the persisted state. Cleanup remains deferred to Milestone 7.

The boundary is half-open: a user action processed with `now < dueAt` passes the
deadline race and proceeds through normal authorization, version, and legality
validation. At `now >= dueAt`, the due system command is processed first and
the user action is stale. Each socket command captures one authority `now`,
drains all deadlines due at that instant in `(dueAt, deadlineId)` order, and
then checks the user's expected state version. Duplicate alarm delivery, a
stale disconnect generation, a reconnect before grace, and an alarm after a
user resolution are all no-ops with durable receipts.

The one platform alarm always points to the earliest pending deadline. State
transitions update the queue in the same transaction as canonical state and
receipts; constructor recovery repairs the platform alarm from the queue. An
alarm invocation processes a bounded due batch, broadcasts one final snapshot
per affected viewer after persistence, and reschedules the next item.

## Modules and ownership

Create modules only when their phase begins:

```text
packages/rules-hong-kong/src/
  engine/game-state.ts
  engine/game-codec.ts
  engine/hong-kong-game.ts
  melds/meld.ts
  claims/legal-reactions.ts
  claims/reaction-resolution.ts
  kongs/kong-transitions.ts
  scoring/hand-fixture.ts
  scoring/decompose-hand.ts
  scoring/detect-patterns.ts
  scoring/award-patterns.ts
  scoring/score-hand.ts
  scoring/payments.ts

apps/discord-activity/src/worker/durable-objects/table-room/
  table-room-protocol.ts
  table-room-game-store.ts
  deadline-queue.ts
```

The existing `TableRoom` remains the lifecycle/transaction coordinator; it must
not absorb parsers, scoring, or queue mechanics. Pure rules modules have no
clock, storage, WebSocket, React, Discord, or Cloudflare imports. The Worker
supplies time and turns due operational commands into ordinary pure-engine
decisions. Client and Worker continue not to cross-import.

## Implementation stages, delegation, and commits

Every stage is assigned to a subagent, ends with focused verification, and is
committed before its dependent stage begins. Agents share one worktree, so each
delegation owns explicit paths and the parent serializes staging/commits.

1. **Freeze decisions and plan.** Update the rules register, profile narrative,
   worked examples, traceability, ADRs, open questions, and roadmap. Commit:
   `docs(rules): freeze claim and scoring decisions`.
2. **Canonical v2 and M5 pure engine.** Add melds, reactions, all kong forms,
   normalized resolution, codecs, migration event, invariants, and pure tests.
   Win is represented structurally but not exposed by the app until scoring is
   integrated. Commit: `feat(rules-hong-kong): add claims and kong transitions`.
3. After Stage 2 freezes shared contracts, run exactly two path-disjoint tasks in
   parallel:
   - **3A scoring core:** only new `scoring/**` modules and their tests; do not
     edit shared exports. Commit after review:
     `feat(rules-hong-kong): score Hong Kong winning hands`.
   - **3B authority persistence:** only Worker game-store/deadline modules,
     migration fixtures, and Worker tests; do not create a second reaction
     authority, implement win resolution, or edit pure scoring. Commit after
     review:
     `feat(table-room): persist reactions and deadline commands`.
4. **Rules integration.** Connect scoring to self/reaction legal actions,
   multi-winner selection, complete results, replay, simulations, and public
   package exports. Commit:
   `feat(rules-hong-kong): resolve scored winning hands`.
5. **Table integration.** Connect reaction resolution and scored completion to
   `TableRoom`, protocol v2, projections, alarms, and eviction recovery. Remove
   v1/dual-reader wire branches and overlap tests; retain only v1-rejection
   fixtures. Commit:
   `feat(table-room): resolve claims and scored wins`.
6. **Client vertical slice.** Add strict v2 decoding, claim/kong/win controls,
   deadline presentation, public melds, and result explanations. Commit:
   `feat(discord-activity): add complete hand controls and results`.
7. **Evidence and hardening.** Run all gates, update roadmap evidence and README
   status, and address cross-layer integration defects. Commit:
   `docs(roadmap): record claims and scoring evidence`.
8. **Independent adversarial review.** A fresh reviewer audits rules outcomes,
   privacy, replay, migrations, alarm races, and UI/protocol strictness. Fix all
   accepted findings in responsibility-scoped commits before opening the pull
   request.

Stages 3A and 3B are the only pre-approved parallel pair. Other stages share
contracts or files and run sequentially. A subagent must not commit unrelated
pre-existing worktree changes.

## Required evidence

### Pure rules

- Exact legal chow/pung/kong actions, invalid physical-ID combinations, and
  next-seat chow restriction.
- Every arrival permutation for representative pass/chow/pung/kong/win sets
  produces byte-equivalent state and event output.
- Seven Pairs accepts exactly seven distinct two-copy kinds and rejects a
  four-copy kind as two pairs.
- Pung/win and chow/pung priority; highest-faan and nearest-seat win ties.
- Concealed, exposed, added, robbed, chained, bonus-chain, and exhausted kong
  paths conserve all 144 physical IDs.
- State/event JSON round trips, v1-to-v2 upgrade replay, forged transition
  rejection, and deterministic random-game simulation.
- Every scoring pattern has positive and near-miss fixtures. Interactions cover
  every implication, exclusion, and supersession edge.
- Three-faan minimum excludes bonus faan; cap, Half Spicy conversion, discard,
  robbing, and self-pick payments match exact fixtures and sum to zero.
- Ambiguous decompositions choose the highest legal score.
- Hand order, equivalent physical-copy substitution, and seat rotation preserve
  results except for explicitly rotated wind/payment facts.

### Worker and persistence

- v1 storage migrates through v4 without losing access/lobby data.
- A permanent active-v3/v1-game fixture verifies its old hashes, appends one
  upgrade event, and continues play after eviction.
- Private intents survive forced eviction and reconnect while opponent and
  spectator bytes do not change.
- Each valid intent appends one hash-linked authority-only canonical event and
  updates the checkpoint without changing public room `stateVersion`; the third
  response atomically appends intent and resolution events in that order.
- Same-actor replay, changed-input/cross-actor collision, first-response
  finality, stale windows, and resolution receipts remain idempotent.
- Deadline tests run immediately before, exactly at, and after due time; duplicate
  alarm, alarm retry, stale generation, reconnect cancellation, user/alarm race,
  and constructor recovery are deterministic.
- Persist-before-publish holds for intents, normalized resolution, completion,
  abandonment, receipts, and deadline updates.

### Protocol and client

- Strict v2 parsers reject unknown fields, impossible melds, repeated visible
  physical IDs, incoherent private actions, and leaked canonical fields.
- Protocol-v1 and absent-version socket requests are rejected and closed;
  protocol v2 has strict wire fixtures and atomic client/Worker rollout and
  rollback evidence using content-hashed assets.
- Players see only their actions/response; spectators and opponents do not.
- Controls disable after final response, while reconnecting, and at local expiry
  without treating the browser clock as authority.
- Result rendering reproduces awarded/suppressed patterns and payment totals
  from structured data.
- Desktop and mobile mock-mode browser smoke tests cover a claim, kong, win,
  reconnect, and score result without console errors or horizontal overflow.

Each implementation stage runs focused tests/typechecks. Final handoff requires:

```text
corepack pnpm check
corepack pnpm app:build
```

## Deliberate exclusions

- Multiple winners, head-bump without faan comparison, passed-win lockout, and
  false-win payment penalties.
- Instant seven/eight-bonus wins, immediate kong payments, responsibility/pao,
  dealer payment multipliers, and alternative Full Spicy or Old Style tables.
- Match balances, dealer continuation, exhaustive-draw continuation, next hand,
  full loser-hand reveal, archives, receipt compaction, and deletion.
- AI players, public matchmaking, Japanese rules, collaborative shuffle
  entropy, and published live hidden-event commitments.

The pull request must close at least one narrow M5 issue and one narrow M6
issue. Its description records rules, protocol, storage, privacy, and deployment
compatibility impacts; names the permanent migration fixtures; lists the
verification commands; and repeats these exclusions.
