# Rust engine implementation contract

The `engine` and `rulesets` crates implement the responsibilities in the component
architecture. This document resolves the initial Rust API and persistence choices;
the component documents remain the responsibility reference. The server and
transport are not wired up by this library implementation.

## Domain boundary

`rulesets::Ruleset` defines initialize, inspect, validate_response, resolve,
advance_hand, project, checkpoint, restore, and validate_context. Associated types keep state,
actions, configuration, explicit inputs, and views variant-specific. Inputs are
borrowed, accepted state is immutable, and a `Transition` contains a candidate
state and its `Inspection`. Inspection carries legal concrete actions by stable
seat position, hand number, phase, and semantic outcome. The runner never reads
tiles or scoring fields.

`Seat` means a stable table position. The Hong Kong ruleset maps it to the changing
seat wind relative to the dealer. Initial wall order and dealer, and each next
hand's wall, are explicit inputs. The library neither obtains entropy nor trusts
a client to provide a wall. A future server must supply a shuffled permutation
from its authoritative randomness source.

Checkpoint envelopes include a ruleset identity and schema version. Restore
rejects unsupported envelopes and invalid domain state. `validate_context` also
checks configuration, participants, and outcome history against the enclosing
coordination record without exposing variant state to the runner. These are new Rust
formats, with no TypeScript checkpoint or wire-format compatibility claim.
Existing TypeScript deployments and their data are unaffected. Migration and
cutover require a separate deployment design.

## Runner and participant boundary

`engine::Engine<R, P>` coordinates a single session through `Store`.
An external runtime serializes method calls and supplies explicit millisecond
timestamps. Occupancy and readiness precede `start_match`; all four participants
must be distinct and ready. A caller supplies a unique match identifier. Seat
assignments are fixed through gameplay and intermission.

`MoveEnvelope` identifies match, round, seat, move, and participant versus fallback
origin. The caller must authenticate the participant and authorize its seat;
these Rust library methods are not an unauthenticated network API. In particular,
clients cannot choose fallback origin or call deadline methods.

Each valid first response becomes durable before acknowledgment. Repeated exact
moves in the same round succeed without another write, including after resolution.
A conflicting second response is rejected. Old match/round work cannot enter a
new batch. Rulesets recheck a complete batch before producing a candidate.
The final response and transition commit together. Failed writes preserve the
previous in-memory state and revision; revision conflicts require reloading the
runner before further work.

`Timing` explicitly configures response duration and intermission (defaults:
60 seconds and 5 seconds). This initial runner uses one response duration for all
opportunities; the TypeScript eight-second claim timer is not a Rust protocol
compatibility requirement. At `now >= deadline`, participant responses expire.
`expire_deadlines` durably marks missing seats for fallback. Mailboxes select
ordinary legal moves and submit them through the same validation path. A failed
or invalid fallback leaves the request pending for retry. The runner never uses
connection state or chooses fallback moves.

`agree_stop` creates or joins a request for the active hand. The first requester
votes yes. Votes persist independently of gameplay collection. At hand completion,
unanimity stops the match after scoring; other requests expire. Requests during
intermission or terminal phases are rejected. Intermission advancement requires
the deadline and an explicit fresh wall; no new readiness is needed between hands.
Terminal matches retain results and require fresh readiness for a new match.

`update(seat)` supplies occupancy/readiness, a permitted view, that seat's actions/acceptance/fallback
state, deadline, stop votes, results and revision. It never supplies checkpoints,
wall order, or another seat's response. Snapshot delivery can repeat after a crash;
recipients deduplicate by revision and resynchronize from the current snapshot.
This is recoverable state publication, not an exactly-once message broker.
A replacement occupant does not receive the former participant's concealed view.

## Persistence

The SQLx SQLite adapter is the concrete local implementation. `Store` keeps
the runner independent of database selection; production deployment topology is
not selected here. A snapshot contains versioned coordination data, rules config,
checkpoint, responses, receipts, deadlines, stop votes, and terminal match history.

A compare-and-swap transaction updates `sessions` and appends the same snapshot
to `session_revisions`. Creation requires an absent session; updates require the
expected revision. Conflicts cannot overwrite accepted progress. Both writes
commit before the runner adopts its candidate or returns success. Restarts
validate the rules checkpoint and the associated coordination data. Previous
hand outcomes are retained; historical hands are not replayed from a move log.

All application SQL uses `sqlx::query!`; migrations use `sqlx::migrate!`. Generated
`.sqlx` descriptions are checked in. `.cargo/config.toml` sets `SQLX_OFFLINE=true`,
so ordinary builds need no schema database. Regenerate metadata after SQL/schema
changes with `backend/scripts/prepare-sqlx.sh`; add `--check` to verify freshness.
The script creates and removes an isolated temporary database and applies the
actual migrations before preparing all targets. SQLx CLI 0.9 is required:

```sh
cargo install sqlx-cli --version 0.9.0 --no-default-features --features sqlite --locked
backend/scripts/prepare-sqlx.sh
backend/scripts/prepare-sqlx.sh --check
```

Snapshots and revision history contain private canonical game information.
Database access is server-only; never send or log those records. History is
currently retained without compaction. Retention limits, encryption at rest,
backup operations, deployment rollback, transport authentication, concrete
mailbox scheduling, and cross-session leaderboards belong to subsequent work.

## Owned implementation and validation

- `rulesets/src/contract.rs`: generic rules boundary and semantic results.
- `engine/src/core/engine.rs` and `core/types.rs`: recoverable coordination and publications.
- `engine/src/storage/mod.rs`: storage contract; `storage/sqlite` implementation and migration:
  atomic SQLite implementation.

No engine runtime tests are currently included; compilation and static checks
do not validate lifecycle or recovery behavior.

Run formatting, warning-free Clippy, tests, and build from the root with `--locked`
where supported. Run ordinary compilation without `DATABASE_URL` to verify the
offline contract, then check metadata freshness against the temporary schema.
