# Table mutation serialization audit

This is a historical prelaunch audit. Its references to intermediate storage
schemas and migration fixtures were superseded by the complete v1 baseline in
[ADR 0017](../decisions/0017-prelaunch-v1-baseline.md). The serialization and
privacy guarantees remain applicable.

Issue: [#26](https://github.com/skjdfhkskjds/mahjong/issues/26). This audit defines
the preparation/commit contract for [#25](https://github.com/skjdfhkskjds/mahjong/issues/25).

## Audited baselines

The initial production baseline is `0bb0ac8b5095d34494c453dc73e367294f64f536`.
The separate, uncommitted `feat/21-solo-mock-players` checkout was inspected
read-only on 2026-09-21. It adds persistent bot identities, schema v5,
`bot_players`/`bot_work`, owner-managed bot seats, and bot processing. Those
changes are not present in the production baseline and are not removed or
reimplemented by this audit. The review below distinguishes that extension.

## Runtime guarantees

Cloudflare's [Durable Object state documentation](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)
states that `blockConcurrencyWhile` blocks unrelated event delivery throughout
its asynchronous callback; callback-initiated work can complete. This covers
more than newly arriving requests. It also documents object reset on an
uncaught callback error and a 30-second timeout. Synchronous SQLite work does
not yield. Reviewed 2026-09-21.

The [SQLite storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync)
specifies private per-object storage and synchronous transaction callbacks,
with rollback on throw. A transaction groups related writes but does not itself
protect preparation before that callback. Storage input/output gates support
ordered storage operations and publication; this code does not use
`allowConcurrency` or `allowUnconfirmed`.

The [Cloudflare input/output gate explanation](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
describes input gating during storage operations and buffering outgoing
messages until writes succeed. `TableRoom` sends only after its transaction
returns. Explicit rollback remains necessary when a callback throws after a
partial batch. No manual `sync()` or generic compare-and-swap layer is needed.

## Entry points, awaits, and transaction ownership

References below use symbols in
[`table-room.ts`](../../apps/discord-activity/src/worker/durable-objects/table-room.ts),
unless another module is linked. Symbol references deliberately survive
subsequent extraction better than line numbers.

| Entry point                                    | Work and asynchronous boundaries                                                                                                                                                                              | Serialization and transaction owner                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Constructor: fresh storage and migration       | Synchronous schema creation, migration, and schema validation; then asynchronous chain verification, optional v1 upgrade hashing, re-verification, presence/game deadline reconstruction, and alarm repair    | Fresh schema and migration own synchronous transactions. Constructor `blockConcurrencyWhile` excludes request delivery through verification/upgrade/recovery; upgrade and reconstructed deadlines use explicit transactions.         |
| `webSocketMessage` command                     | Attachment/grant/session validation and wire parsing are synchronous. Gate drains due work, verifies history, decides, hashes, and applies the client command. Receipt/snapshot send and alarm repair follow. | Gate encloses `drainDueDeadlines` and `applyTableCommand`. The command owns the transaction for events, checkpoint, public revision, receipt, and replacement deadlines.                                                             |
| `webSocketMessage` resync                      | Synchronous viewer projection only                                                                                                                                                                            | No authoritative mutation. Current grant checks still apply.                                                                                                                                                                         |
| `alarm`                                        | Gate drains due work and repairs alarm; broadcast follows                                                                                                                                                     | Same gate as player commands. `processDeadline` prepares under the gate; `completeDeadlineWithReceipt` owns each deadline transaction, including its callback's game/lifecycle writes.                                               |
| `fetch`: `/internal/bindings/apply`            | Await bounded body parsing; resume also hashes the bearer before reading mutable rows. Create/resume, pending receipt, and final receipt handling are synchronous after those awaits.                         | `applyCreate`/`applyResume` own transactions. Pending/final saga receipt statements have no intervening await around mutation. Operation IDs recover a previously applied binding. No outbound RPC occurs in TableRoom's apply path. |
| `fetch`: invitation/resume capability creation | Await body and secret hashing before checking current binding, owner, session, and writing capability                                                                                                         | `createCapability` owns a synchronous transaction. No mutable-state assumption is carried over hashing.                                                                                                                              |
| `fetch`: invitation redemption                 | Await body and secret hashing before authorization, consumption, membership, and public revision                                                                                                              | `redeemInvitation` owns a synchronous transaction. Broadcast follows.                                                                                                                                                                |
| `fetch`: session activation                    | Await body, then check binding and session generation, upsert session, and close replaced sockets synchronously                                                                                               | One synchronous state-check/write span; no canonical-game mutation. Requests may arrive out of generation order.                                                                                                                     |
| `fetch`: `/connect`                            | Validate headers/grant, write connection/presence state, accept socket, reconcile deadlines, publish, then await alarm storage                                                                                | Transactions own grant/lifecycle revision and deadline changes. All game-dependent reads and changes occur before the first await.                                                                                                   |
| `webSocketClose`                               | Delete grant and reconcile presence deadlines, then await alarm storage                                                                                                                                       | One synchronous transaction before the first await. Seat reservations remain. `webSocketError` only closes the socket.                                                                                                               |
| `repairAlarm`                                  | Await `getAlarm`, synchronously read current pending minimum, then await `setAlarm`/`deleteAlarm` if needed                                                                                                   | Storage operations use runtime input gates; it does not prepare a canonical-game batch. Constructor and drain callers also hold the broader gate.                                                                                    |
| #21 bot seat management                        | `changeBotSeat` runs in the lobby branch of `applyTableCommand`                                                                                                                                               | Same gate and command transaction; no new entry point.                                                                                                                                                                               |
| #21 bot execution                              | `drainDueDeadlines` processes human deadlines, then due `bot_work`, projects one bot's legal actions and calls `applyTableCommand`                                                                            | Both callers of drain are gated. Each bot command uses the same atomic writer and actor-scoped receipt.                                                                                                                              |
| #21 bot work reconciliation                    | Command/deadline transactions reconcile work; `repairAlarm` additionally reconciles synchronously before its first await                                                                                      | Same transaction as the transition that creates/replaces work; no independent async game writer. Constructor recovery also repairs bot work/alarm.                                                                                   |

No supported production caller prepares canonical changes outside these gated
paths. The exported `persistPreparedGameBatch` convenience wrapper is used only
by isolated Workers-runtime fixtures; it delegates to the same in-transaction
writer. Those fixtures prepare sequentially without competing requests; one
test deliberately reuses a committed batch to exercise SQL uniqueness. It is
not a second production command API. A new caller must own serialization from
verified read through commit, not merely call the transaction wrapper.

HTTP body/hash completion and socket events cannot mutate the table during a
gated game operation. Outside that gate, HTTP mutations read mutable state only
after their non-storage awaits and then write synchronously. Preparation before
`transactionSync` therefore establishes no internal race in these paths.

## Guard inventory

“Necessary” below names a semantic, integrity, or callback contract, not an
unspecified concurrency precaution. “Redundant” means the audit found no
supported interleaving that needs the repeated check.

| Check and code reference                                                                                                                                        | Classification and concrete scenario                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyTableCommand`: `expectedStateVersion`                                                                                                                     | Necessary client freshness: client B acts on version N after client A has committed N+1, even with serial execution.                                                                                                                   | Retain stale receipt and fresh viewer snapshot. Preflight equality skips expensive preparation; the later branch produces the receipt. These are two uses of one client condition, not a second server revision contract.    |
| `applyTableCommand`: existing receipt actor/request comparison                                                                                                  | Necessary retry and privacy: identical retry must not apply twice; a different actor/input using the same ID must not receive the first actor's response.                                                                              | Retain receipt lookup before freshness rejection, canonical request comparison, receipt PK, and atomic receipt/state writes.                                                                                                 |
| `applyTableCommand`: `validPrevious` / `expectedPreviousHash`                                                                                                   | Redundant internal race check: all three canonical writers hold the gate; private intent preparation cannot overlap another canonical append. Store also repeated the same hash condition.                                             | Removed by this change.                                                                                                                                                                                                      |
| Game store: `assertBatchPrecondition`, `expectedPreviousHash`, `expectedPreviousSequence`                                                                       | Redundant internal race check across constructor, command, deadline, and #21 bot callers. No supported independent writer can advance the checkpoint between verified read and commit.                                                 | Removed by this change; caller-owned serialization is documented on preparation and both writers.                                                                                                                            |
| Game store: `verifyStoredGame`, closed decoders, event sequence/hash/replay/checkpoint comparisons                                                              | Necessary persisted integrity: a damaged event hash, missing row, unknown version, or divergent checkpoint must fail recovery. Serial processing cannot repair historical corruption.                                                  | Retain. These verify stored bytes, rather than compare current storage to an earlier in-flight assumption.                                                                                                                   |
| Game store: reducer invariants, digest format, nonempty batch, upgrade replay equality                                                                          | Necessary preparation correctness: malformed events, digest providers, or inconsistent legacy upgrades must fail before writing.                                                                                                       | Retain. Preparation remains authority-owned, not an external unvalidated batch API.                                                                                                                                          |
| SQLite event sequence PK, hash uniqueness, seat/actor uniqueness, FKs and schema checks                                                                         | Necessary data integrity: duplicate rows, dangling bot/deadline/member relations, invalid schema roots and partial migration must fail atomically.                                                                                     | Retain. Constraints do not substitute for history verification.                                                                                                                                                              |
| `deadlineStillTargetsCurrent`                                                                                                                                   | Necessary queued-work freshness: a reconnect, prior turn, resolved reaction, or renewed room activity can invalidate an old persisted deadline before it is selected.                                                                  | Retain one check per prepared operation; exact window/turn/connection/room generation is distinct from public version.                                                                                                       |
| `processDeadline`: second target read inside completion callback; generation/autopilot predicates on subsequent updates                                         | Redundant internal race checks after the first target decision in the same gated operation.                                                                                                                                            | Consolidation candidate for #25: carry the first decision into the synchronous callback and simplify updates. Preserve stale-target receipts and cancellation handling. No new expected-state argument is required.          |
| Deadline queue: status/due-time reads and system receipts in `completeDeadlineWithReceipt`                                                                      | Necessary retry/cancellation: alarms are at least once; an earlier item in the bounded drain may cancel another selected item; direct queue callers may retry an already processed item.                                               | Retain read of the stored deadline, cancelled no-op, original receipt replay, and coherence checks. A preselected due list is not an authoritative current status.                                                           |
| Deadline queue: conditional completion update and `rowsWritten` assertion                                                                                       | Necessary callback integrity for this exported helper: its synchronous callback receives raw SQL and can cancel/delete the current deadline. Completion must roll back rather than persist a processed receipt against changed status. | Retain until #25 prevents callback mutation of the current deadline through its typed contract. This is a callback postcondition, not an inter-event race.                                                                   |
| Deadline queue: schedule collision check and pending-only cancellation                                                                                          | Necessary idempotency/status semantics: an identical schedule is harmless; reused ID with different target/time is invalid; cancelling completed work must preserve receipt coherence.                                                 | Retain. `rowsWritten` distinguishes insertion/cancellation outcomes, not competing writers.                                                                                                                                  |
| Presence reconciliation: pending-only updates after selecting matching pending rows                                                                             | Redundant repeated status predicates within a synchronous span; bulk pending selection itself is necessary to avoid rewriting history.                                                                                                 | #25 may omit the repeated predicates for individually selected rows. Preserve expired-grant reconstruction, earlier grace deadline, retired actors, and consumed-ID replacement rules.                                       |
| Binding receipt request equality, pending/applied operation ID, operation expiry                                                                                | Necessary saga/replay semantics: a response can be lost after TableRoom applies a binding; replay must recover that result, while changed input under the ID must fail.                                                                | Retain. Another Durable Object cannot share TableRoom's transaction.                                                                                                                                                         |
| Capability subject/hash, expiry, consumed state and expected binding generation                                                                                 | Necessary authorization/replay: a used invitation cannot admit twice; a capability issued for an earlier binding cannot rebind the current table.                                                                                      | Retain these reads and typed outcomes. They protect against sequential replay, not simultaneous SQL access.                                                                                                                  |
| `applyResume`: conditional capability/table updates, `rowsWritten`, `AtomicMutationConflict`; `redeemInvitation`: conditional consumed update and `rowsWritten` | Redundant internal race checks: matching row and generation/consumption were read and validated in the same synchronous transaction; no intervening callback or trigger mutates them.                                                  | #25 cleanup: update by selected keys, remove unreachable conflict translation/class after both uses disappear. Keep transaction ownership and consumed/stale-binding errors. Reuse concurrent redemption/resume retry tests. |
| `activateSession`: prior-generation rejection                                                                                                                   | Necessary session ordering: delayed activation for generation N can arrive after N+1.                                                                                                                                                  | Retain explicit stale response and current-grant checks on each connect/message.                                                                                                                                             |
| `activateSession`: duplicate generation `WHERE` in upsert                                                                                                       | Redundant after the preceding synchronous generation check.                                                                                                                                                                            | #25 can remove this SQL predicate while retaining the explicit stale response. Reuse session replacement and concurrent logout tests.                                                                                        |
| #21 bot work target/due checks, unchanged-target reconciliation and persistent command ID                                                                       | Necessary queued-work identity: an earlier due action can end a reaction/change the target; recovery must preserve pending work timing and retry identity.                                                                             | Retain target semantics and actor-scoped receipts. They are not generic optimistic concurrency.                                                                                                                              |

The redundant predicates left as consolidation candidates are explicitly **not**
requirements of the new storage interface. This PR limits runtime removal to
the overlapping game-hash checks central to #25's commit contract. The listed
SQL cleanups require no new wire or persisted fields. Their named existing
behavioral suites, full check, and build are the validation requirement.

## Cross-object operations are different

[`ActivityInstance`](../../apps/discord-activity/src/worker/durable-objects/activity-instance.ts)
does await another Durable Object between proposal and promotion. Two session
issuances can read the same old credential, await TableRoom activation, and
complete in opposite order. `promoteSession` must compare its expected stored
session before publishing a credential. Likewise, logout can validate an old
credential, yield to activation, and resume after a replacement; the
transactional `allocateRevocation` comparison prevents revoking the replacement.
These concrete cross-object interleavings justify those guards. The binding
saga's operation IDs and pending/current checks likewise survive retries and
partial cross-object success. This audit does not remove them or introduce a
cross-object transaction abstraction.

## Minimal application/storage contract for #25

1. `TableRoom` owns the serialization scope: verified load, deadline/bot
   selection, decision, async hashing, atomic commit, then publication. The
   storage adapter owns synchronous transaction implementation; it does not
   export raw SQL to application coordinators or accept generic expected-hash
   or expected-sequence CAS tokens.
2. A typed commit includes canonical events/checkpoint, applicable command or
   system receipt, public revision effect, deadline changes, and bot work
   changes. Failure rolls back all related writes. Preparation stays outside
   the synchronous transaction but inside the caller's gate.
3. Client freshness, actor-bound retries/collisions, capability/session checks,
   queued target identity, and persisted decoding/replay have explicit typed
   results. Do not collapse them into a generic storage conflict.
4. Canonical sequence/hash can advance while public `stateVersion` does not.
   Two private reactions at the same public version must both append; only
   resolution publishes. Canonical hashes never enter viewer responses.
5. Recovery retains historical bytes and validates them before authority use.
   Preserve permanent v1/v3 roots and #21's v4 root; an internal API extraction
   alone needs no storage migration or new encoding.
6. The separately coordinated player/seat controller work is application-layer
   selection of human, persistent bot, or disconnected-player input. It must
   feed the same serialized command/deadline pipeline and retain player
   identity, disconnect grace, and reconnect cancellation. It is not a storage
   writer or a reason to add optimistic commit guards. Audit its committed
   implementation before integrating; do not reconstruct the preserved work.

## Verification evidence

The concurrent private-reaction runtime regression sends separate socket
commands at one public revision and verifies accepted private intents, retry
receipts, hash/replay consistency, and publication only on resolution. Existing
runtime tests cover stale clients/collisions, exact deadline boundaries,
cancelled/stale/duplicate deadlines, transaction rollback, invitation
consumption, session replacement, old-schema migration, corruption failure,
and forced eviction. Together these validate removal without treating
concurrent arrival itself as evidence of concurrent mutation.

The authority-persistence test deliberately reuses a committed prepared upgrade
batch. SQLite rejects its first event on the existing sequence primary key,
and checkpoint, event, receipt, and public-version rows stay unchanged. This
satisfies #25's stale-prepared-change rejection case without inventing a
reachable production race or adding a hash CAS. It does not promise validation
of arbitrary forged prepared batches: only authority preparation may construct
them, and full persisted-history verification remains the recovery boundary.

Required handoff checks are `corepack pnpm check` and
`corepack pnpm app:build`; external deployment and credentialed smoke testing
remain outside this audit.
