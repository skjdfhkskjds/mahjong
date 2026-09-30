# Table application and storage boundaries

Issue: [#25](https://github.com/skjdfhkskjds/mahjong/issues/25).

## Operation inventory before extraction

The review baseline is the verified #33 controller prerequisite,
`e2e8d268bab86cae91c0489c3ce9620b026e1047`, on top of canonical #21 and the
landed engine and mutation-check audits. The extraction preserves their policies.

| Operation                          | Decisions owned by application                                                                                                              | Atomic persistence boundary                                                                                                                                                 | Runtime effects after persistence                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Player command                     | Actor/request receipt replay or collision; client freshness; lobby permission/readiness; engine decision; private/public publication intent | Seat/readiness changes or event batch and checkpoint, public version when visible, receipt, associated deadlines and scheduled bot work                                     | Sender receipt, sender resync or viewer-specific broadcast, alarm repair |
| Due system command                 | Current deadline status and semantic target; engine expiry/automation decision; lifecycle transition; original receipt replay               | Canonical batch/checkpoint, lifecycle/controller changes, public version, replacement work, system receipt and processed deadline                                           | Viewer-specific broadcast if public, next alarm                          |
| Create binding                     | Admission expiry, operation collision/replay, existing table identity, owner                                                                | Table record and owner membership together; pending/final saga receipt surrounds the local operation                                                                        | Return binding proof to ActivityInstance                                 |
| Resume binding                     | Owner, capability subject/hash/expiry/consumption and issued binding generation                                                             | Consume capability, replace binding and proof, clear actor sessions together; finalize operation receipt                                                                    | Return new binding proof; old grants fail current-binding checks         |
| Issue invitation/resume capability | Current binding/session, owner, valid subject                                                                                               | Insert one capability containing only its digest                                                                                                                            | Return bearer once                                                       |
| Redeem invitation                  | Binding/session and capability checks; whether membership is new                                                                            | Consume invitation, insert member if absent, increment public version only for new membership                                                                               | Broadcast when membership changes                                        |
| Activate session                   | Binding validity, monotonic actor session generation, member response                                                                       | Session upsert plus deliberate-departure controller/work/revision changes; nonmembers still receive the generation needed for invitation redemption                         | Close replaced actor sockets after persistence; return membership result |
| Connect                            | Current grant authority, seated recovery and controller/presence policy                                                                     | Grant, human controller restoration, substitute-work cancellation, lifecycle state and visible revision together; presence/game deadlines reconcile after socket acceptance | Accept socket, snapshot/broadcast, alarm repair                          |
| Close                              | Remove exact grant; retain actor seat; derive presence from other valid grants                                                              | Grant removal and presence deadline reconciliation together                                                                                                                 | Alarm repair                                                             |
| Recovery                           | Verify event-chain/checkpoint coherence; reconstruct work from durable state and current grants                                             | Strict v1 storage validation; presence/game/bot work reconciliation                                                                                                         | Restore alarm before delivery resumes                                    |
| Resync                             | Current viewer authority                                                                                                                    | Read only                                                                                                                                                                   | Viewer-safe snapshot                                                     |

ActivityInstance binding and session promotion are separate Durable Object
operations. They cannot share a SQLite transaction with TableRoom. Operation
IDs and persisted pending/applied receipts retain recovery after lost RPC
responses. No application interface promises a transaction across those objects.

## Serialization and dependency direction

TableRoom owns platform entry points and the serialized interval spanning
verified reads, application decisions, asynchronous canonical hashing, and one
atomic commit. SQLite transactions are synchronous; hashing happens before
entering them. The #26 audit defines which semantic checks remain necessary;
there is no generic expected-hash or expected-sequence compare-and-swap API.
HTTP body/digest preparation precedes mutable reads, followed by synchronous
application decisions and commit. No application policy executes inside a
storage callback receiving raw SQL.

Application operations depend on typed record reads and operation-level prepared
commits. The SQLite adapter depends on those contracts and owns row mapping,
persisted validation, constraints, and rollback. Rules remain below
application orchestration and never receive command receipts, session state,
public room versions, or scheduling workflows. TableRoom consumes committed
publication intent and executes socket and alarm effects.

Canonical progress and public room progress remain separate. A private reaction
persists its event, checkpoint, and receipt while leaving the public version
unchanged. Only the submitting connection receives its acknowledgement/snapshot.
Resolution persists the final intent and resolution together before publication.
Canonical events and hashes are never socket payloads.

## Concrete command flow

1. TableRoom validates transport/authority and enters its serialization gate.
2. The application resolves actor-scoped command replay/collision and client
   freshness through typed records.
3. Lobby policy or the gameplay adapter decides the transition. Application
   code prepares the canonical batch, public-version effect, receipt, deadlines,
   and any controller work required by that transition.
4. The storage adapter applies the prepared operation in one synchronous
   transaction. Any constraint or write failure rolls back every related row.
5. Only a committed result permits TableRoom to acknowledge and publish freshly
   projected viewer state, then repair the platform alarm.

The complete-v1 fixture verifies recovery and strict storage validation. The
prelaunch version reset in ADR 0017 changes genesis bytes and their resulting
hashes without changing the event-hash encoding or rules semantics.

## Modules and verification

- `table-command-application.ts` owns command tracking, client freshness, lobby
  decisions, engine dispatch, prepared receipt/version/work, and publication
  intent. `table-command-store.ts` implements command and system atomic commits.
- `table-system-application.ts` combines queue receipt planning with semantic
  deadline targets, engine expiry, and lifecycle transitions. The pure
  `table-deadline-application.ts` owns replay/cancellation planning and canonical
  tracking records; `deadline-queue.ts` maps and verifies persisted rows.
- `table-access-application.ts` coordinates binding, invitations, and sessions
  through `table-access-store.ts`. Completing a binding now commits its final
  receipt with the local binding changes; legacy pending receipts still recover
  through the already committed operation ID.
- `table-presence-application.ts` prepares connection, disconnect grace, and
  abandonment effects. `table-connection-application.ts` combines them into
  connection/recovery operations; the connection/presence adapters only persist
  those changes. Existing presence/deadline convenience wrappers remain for
  focused runtime fixtures; production operations use prepared commits.
- `table-game-events.ts` prepares canonical batches independently of SQL.
  `table-room-game-store.ts` retains event-chain verification, checkpoint reads,
  v1 schema validation, and writes. `table-game-scheduling.ts` translates engine targets
  into the existing eight-second reaction and 60-second human-controller turn
  work, preserving generation-specific identities when a cancelled turn resumes.
- `table-bot-seating.ts` and `table-controller-application.ts` prepare bot seating
  and shared controller work. SQLite writers persist membership, controller
  generation, deadline cancellation and replacement jobs within their enclosing
  command, session, connection or system operation. The parent `TablePlayers`
  runtime retains source arbitration, actor views and origin-only outcomes.

Deliberate active-hand departure removes the exact originating grant and retains
the actor, seat and hand. Its existing negotiated/legacy terminal close behavior
is preserved. Transient loss retains the parent grace and heartbeat policy.
Every alarm repair takes fresh presence observations before scheduling the next
health poll, so ordinary command traffic cannot postpone health observation.

`vitest.application.config.ts` runs application operations against typed memory
stores under Node. Workers tests inject failure after earlier operation writes
and assert rollback of events, checkpoints, receipts, public versions,
deadlines, seats, automation, and lifecycle state. Reusing a committed prepared
batch fails SQLite sequence uniqueness with every related row unchanged;
this demonstrates integrity without introducing speculative optimistic CAS.

The controller implementation and policy are recorded in ADR 0016; the
prelaunch format baseline is recorded in ADR 0017. The extraction adds no new
rules or controller policy.
