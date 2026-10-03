# `@mahjong/game-core`

## Owns

Variant-neutral identities, tiles, seats, viewers, genesis/replay helpers, and one
concrete runtime-free gameplay engine. `createGameEngine(policy)` enforces four
unique seated participants, active-turn eligibility, reaction membership and
first-response finality. It applies ordered effects, controls final-response
resolution, computes turn/window transitions, and validates their correspondence
with the reduced canonical state.

The policy evaluates a move once into rejection, applied effects and outcome,
legal pending submission, or immediate completion. The engine resolves a window
only after all responders submit or an explicit due expiry arrives. Resolution
outcomes are ruleset types; the engine does not inspect tile or event internals.
A legal pending win can consequently resolve to a different winner without
becoming an illegal claim.

`deadlineTarget` exposes the current logical generation, stage/seat or window.
`expire` requires an exact target and explicit safe-integer due time and `now`.
It rejects early/stale expiry. Turn expiry and `automate` execute the policy's
ordinary moves through the same pipeline, accumulating draw/discard effects
until the actor's turn ends. Compound automation returns `kind: "automated"`
with each accepted step and its corresponding typed outcome and effects, plus
one combined event batch for atomic persistence. Single-move automation retains
that move's result kind. Each turn stage is visited at most once; a repeated
stage is a policy invariant failure. A reaction automation submits once.

## Does not own

Bonus tiles, scoring, claim priorities, kong semantics, match progression,
networking, persistence, real clocks, randomness, React, Discord, or Cloudflare
APIs. Authentication, table membership, readiness, connections, receipts, retries,
public versions, presence grace, controller selection, and bot jobs remain
application responsibilities. Policies own variant-specific legality, outcomes,
semantic automatic moves, projections, and canonical validation/replay.

## Dependencies

This package has no runtime dependencies and may not import any other project
package. It is compiled without Node, DOM, React, or Workers ambient types.

## Public entry point

Only `@mahjong/game-core` is public. Internal file imports from another package are
prohibited. The former unused `RulesetEngine` interface has been replaced by the
concrete engine and focused `GamePolicy` contract; genesis/replay helpers remain.

## Invariants

- Identifiers are non-empty after trimming but preserve their original value.
- Physical tile IDs are non-negative safe integers.
- An accepted game decision emits at least one domain event.
- A rejected game decision contains at least one rule violation.
- Rejected engine moves have no accepted effects; pending responses are private;
  resolved and ordinary outcomes are public publication requirements. Canonical
  effects themselves must never be published to viewers.
- Participants and lifecycle are reconstructed from validated canonical state;
  they are not a second persisted authority. Mismatched policy transitions fail
  before an accepted result can escape.
- Genesis is a JSON-safe, runtime-validated snapshot at event sequence zero; every
  later domain event is replayed in order through the reducer.
- Canonical state, configuration, and domain events contain only finite JSON-safe
  values. Runtime-rich representations require an explicit codec outside the
  persisted contract.

See [the Hong Kong mapping](../../docs/architecture/shared-game-engine.md) for
concrete move and timeout examples and retained-format boundaries.
