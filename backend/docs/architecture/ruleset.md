# Ruleset

The ruleset is the in-memory domain state machine in the
[backend redesign](README.md). It defines move legality, state transitions,
eligible responding seats, available actions, competing-response resolution, and
hand and match outcomes. The [runner](runner.md) owns persistence and acceptance
of its candidate transitions.

The responsibilities and response-validation behavior are agreed. Operation and
data shapes below are proposals for discussion, not implemented APIs or a frozen
implementation contract.

## Boundary

The ruleset has no database, network, WebSocket, connection-status,
ambient-clock, or ambient-randomness dependency. Any required time, identifiers,
and randomness are explicit inputs. It does not schedule timers or choose fallback
moves because a client disconnected or a deadline expired.

The runner treats variant-specific state as opaque. Ruleset output must provide
enough semantic information for coordination without requiring the runner to
understand tile kinds, claim ranks, or scoring logic.

Canonical state and internal transition data remain authoritative private data.
The ruleset provides permitted seat views and available actions for their intended
viewers separately from canonical state.

## Agreed response validation

Validation is a minimal, separate operation: current ruleset state plus a
proposed transition produces a validity result without changing state. Detailed
Mahjong legality remains inside the ruleset and can be specified later.

The runner checks every proposed gameplay move before collecting it in its
in-memory response buffer. Invalid moves are rejected immediately; the seat may
retry until its original deadline while the other seats continue responding.
Only valid responses count toward the complete batch. Accepted partial responses
still need to be recoverable through the repository.

## Operations under discussion

| Operation         | Input                                                                                                    | Output and responsibility                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Initialize        | Rules configuration, fixed match participants, and explicit initialization inputs                        | A candidate fresh match state, validated under the selected ruleset.                                                      |
| Restore           | A saved ruleset checkpoint and its version                                                               | Validated logical state, or an unsupported or invalid checkpoint result. Storage I/O stays with the runner.               |
| Inspect           | Accepted state                                                                                           | Lifecycle phase, eligible responding seats and available actions, and any hand or match outcome.                          |
| Validate response | Current ruleset state and one proposed transition                                                        | A validity result without a transition. This behavior is agreed; final type names remain open.                            |
| Resolve responses | Accepted state, the response opportunity, the complete seat-response batch, and required explicit inputs | Rejection information or a candidate next state with its semantic outcome. The ruleset resolves competition and priority. |
| Project           | Accepted state and the viewing seat                                                                      | Only the information that seat is allowed to receive.                                                                     |

These are responsibilities, not final TypeScript names or a choice between a
class and functions.

## Data shapes to define

- **State:** complete rules-owned match and hand state, including decisions that
  depend on randomness. The runner does not interpret variant-specific contents.
- **Opportunity:** the seats asked to respond and the actions each may take. The
  runner associates the published opportunity with a response-round identity and
  deadline; the exact division of identifiers is still open.
- **Response batch:** one response from each requested seat against the same
  accepted opportunity. Seat order and arrival order must not accidentally choose
  a Mahjong claim winner.
- **Transition result:** rejection or candidate next state and explicit hand or
  match outcome. It does not publish or write data.
- **Seat view:** information permitted for the seat, separate from canonical state
  and internal transitions.
- **Checkpoint:** a validated, versioned representation that the runner can save
  and restore. The encoding remains to be chosen.

## Boundary guarantees

1. Resolving a batch cannot mutate accepted state. That state must remain unchanged
   if persistence fails.
2. A complete batch is checked for legality and completeness when resolved, even
   when individual responses were checked during collection.
3. Ruleset decisions use explicit inputs rather than runtime services.
4. Fallback moves are ordinary proposed moves for legality purposes. Their
   selection belongs to the participant implementation.
5. Output identifies semantic outcomes directly. The runner does not infer a win,
   hand completion, or claim priority from transport messages.
6. Restored valid state and the same explicit inputs produce consistent decisions.

## Transition result proposal

After resolving a complete batch, the runner needs:

- Candidate next ruleset state, to persist before accepting it.
- The next eligible responding seats and available moves, if play continues.
- An explicit hand or match outcome and its results when one completes.

The proposal makes this information available at the transition boundary.
Whether opportunities are fields in the result or come from a separate inspection
of the candidate state remains open. Permitted views remain separate from
canonical state regardless of that choice.

## Next design decisions

Start with the transition result and how the runner obtains next opportunities.
Individual validation is settled; concrete Mahjong rules need not be designed to
establish this boundary.

Then define state and result types, rejection behavior, available-action
representation, the checkpoint envelope, and how the runner asks the ruleset to
advance after intermission. Match-stop coordination remains runner-owned.

Match length, dealer progression, draws, and score semantics require an explicit
ruleset profile. Timeout durations, fallback retry limits, deployment
compatibility, and database schema are outside this initial ruleset contract.
