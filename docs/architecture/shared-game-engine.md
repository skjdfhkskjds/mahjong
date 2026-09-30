# Shared gameplay engine and Hong Kong policy

This extraction preserves the Milestones 5–6 rules, canonical schema v1,
encoding v1, protocol v1, and room schema v1. It adds no match progression.
The following mapping is the design input, taken from the existing decisions,
reducers, scoring fixtures, and ADR 0013 before choosing the policy signatures.

## Existing behavior mapped to policy outcomes

| Input and current implementation                                                                       | Shared mechanics                                                                                                                             | Policy input and typed consequence                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game/draw`, `decideDraw`, `DrawnEvent`                                                                | Validate participant and active turn; apply ordered effects; retain active seat                                                              | Canonical hand/wall and actor. `drawn` carries ordinary tile and recursive bonus replacements; `exhausted` distinguishes unavailable ordinary draw from failed bonus replacement. Drawing the final structural tile succeeds.                                                                                         |
| `game/discard`, `decideGameCommandV1`, `DiscardReactionOpenedEvent`                                    | Validate active turn; open identified window and track responders                                                                            | Canonical phase, exact owned tile, replacement requirement. `discarded` opens `discard:<sequence>` with three non-source responders; nominal next seat is shared turn order.                                                                                                                                          |
| `game/react` pass/chow/pung/kong/win, `decideReaction`, `isLegalReaction`, `scoreReactionWinCandidate` | Validate window identity, responder membership, first response finality; record private response; resolve when all responders have submitted | Exact physical response and canonical window. Illegal response is `rejected`; legal response is `pending` with window identity and accepted submission effects. Win legality includes the non-bonus three-faan minimum. Pending never carries settled payments.                                                       |
| Last response or `decideReactionExpiration`, `normalizeReactionWindow`                                 | Close the window once; apply policy-selected continuation; advance ordinary turn or transfer active seat                                     | Canonical collected intentions. Absent responses normalize to pass. `all-pass` advances to source's successor; `meld-claimed` selects chow/pung and requires discard; `kong-claimed` includes tail replacements or exhaustion. Win outranks pung/kong, which outrank chow.                                            |
| Competing reaction wins, `expectedPendingCompletion`, `resolveScoredReactionWinner`                    | Deliver finalized resolution without interpreting claim ranks or score                                                                       | Eligible recorded wins select highest capped faan, then nearest source seat. `hand-won` contains the actual scored result and each legal win claimant's awarded/not-awarded status. An unselected legal claim is never rejected. Last response includes its intent before resolution/completion effects in one batch. |
| `game/declare-concealed-kong`, `legalConcealedKongs`, `replacementFromTail`                            | Keep active participant and apply multi-effect decision                                                                                      | Exact canonical four tiles. `concealed-kong` commits the meld then recursively replaces from tail; required replacement exhaustion is explicit.                                                                                                                                                                       |
| `game/propose-added-kong`, `legalAddedKongs`                                                           | Open robbing window, keep proposer active while collecting responses                                                                         | Exact pung ID and fourth tile. `added-kong-proposed` opens `added-kong:<sequence>` without committing the kong.                                                                                                                                                                                                       |
| Added-kong window resolution, `commitAddedKong` and `replacementFromTail`                              | Close window; keep proposer or transfer to selected winner                                                                                   | Only win/pass are legal. `added-kong-completed` commits then replaces, including exhaustion; `hand-won` reports robbed-kong source and scored winner without committing the proposal.                                                                                                                                 |
| `game/declare-win`, `scoreSelfWinCandidate`, `SelfWinDeclaredEvent`, `HandCompletedEvent`              | Finish the hand and clear live scheduling                                                                                                    | Rules-valid score and provenance produce immediate `hand-won` with finalized score/payment result. Invalid structure or subminimum score rejects without effects. Structural completion alone is insufficient.                                                                                                        |
| Initial setup, `startHongKongV1Game`, initial deal/replacement                                         | Restore validated participants and active lifecycle from genesis                                                                             | Policy retains shuffle/deal/bonus semantics and exact genesis bytes. Initial exhaustion is already represented by canonical `exhausted`; no synthetic move is introduced.                                                                                                                                             |
| Connected turn timeout, `automaticGameEvents`                                                          | Validate explicit logical target and due boundary; execute ordinary moves through the same pipeline                                          | Policy selects draw followed by discard of last-acquired tile, or lowest canonical ID fallback; recursive replacements/exhaustion use the same draw decision. Never choose win/kong.                                                                                                                                  |
| Reaction timeout                                                                                       | Validate explicit window target and due boundary; resolve collected responses once                                                           | Policy normalizes missing replies to pass and supplies the same typed resolution as the final response path.                                                                                                                                                                                                          |
| Autopilot activation, disconnected reaction pass                                                       | Application chooses automated actors; engine enforces participant/window/turn eligibility                                                    | Policy supplies deterministic pass/draw/discard. Presence grace, controller changes, bot jobs, reconnect generations, abandonment, and actual timers stay outside the domain.                                                                                                                                         |

Evidence is retained in `claims-kongs.test.ts`, `win-resolution.test.ts`,
`stage2-evidence.test.ts`, the draw/discard tests, scoring fixtures, and Workers
deadline/private-reaction/recovery tests. These are semantic baselines, not
permission to simplify replacement chains or claim arbitration.

## Ownership and compatibility

`game-core` implements participant validation, ordinary turn gating, reaction
submission/completion, policy-directed turn changes, event-batch application,
and explicit logical expiry. A policy decides legal effects and semantic
outcomes together. The engine does not inspect Hong Kong event names or tile
internals. Hong Kong retains exact physical-tile rules, scoring, private
projection, and version-specific canonical validation/replay.

The live lifecycle is reconstructed from a verified canonical checkpoint;
it is not a second persisted authority. Existing canonical fields remain the
compatibility representation, checked against engine transitions. Replay
continues validating historical effects, including intermediate replacement
and win-validation states that never escape as accepted live outcomes.

The concrete API is `createGameEngine(policy)`: `execute` returns `rejected`,
`applied`, `pending`, or `resolved`. `pending` contains accepted submission
effects and a domain window ID but no score/result. `resolved.result` narrows to
Hong Kong `self-win` or `reaction`; a reaction win includes explicit
`awarded`/`not-awarded` claimant entries. Non-winning reaction resolutions
distinguish all-pass, meld claim, exposed kong, and committed added kong.
Replacement outcomes distinguish successful draws from exhaustion.
`automate` and `expire` additionally return `automated` for a compound turn,
retaining each accepted step's outcome alongside the ordered combined effects.
No caller infers these outcomes from event names.

For example, a legal discard supplies its exact event and typed opening
outcome. The engine opens the identified reaction window, accepts private
responses, and asks the policy to resolve when the last responder acts.
The application persists the full batch before publishing its safe projection.

For a timeout, the application restores a persisted logical target and due
time and passes explicit `now` to the engine. The engine rejects early or stale
expiry; the policy supplies the semantic resolution. SQLite receipts and
Cloudflare alarm repair remain application responsibilities. Private submissions
retain the window's opening generation and original due time.
