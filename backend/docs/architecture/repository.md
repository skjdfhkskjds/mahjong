# Repository and recovery

Implementation note: the [Rust implementation contract](implementation.md)
resolves the initial API, coordination, and local SQLx persistence choices. This
component document records responsibilities and the original design questions.

The repository is the persistence boundary in the
[backend redesign](README.md). The [runner](runner.md) owns loading, saving,
transaction coordination, and acceptance of transitions. The
[ruleset](ruleset.md) stays in memory and performs no storage I/O.

## Persistence boundary

The runner receives a candidate next state from the ruleset. It atomically
persists the accepted transition and related coordination changes before
adopting the candidate in memory or publishing updates. If the save fails, the
accepted game state remains unchanged.

Partial responses and stop votes also need recoverable records. The runner's
in-memory buffer is a working representation rather than the only copy of
accepted coordination progress. Acceptance acknowledgements that depend on a
write follow successful persistence.

The repository stores canonical private information securely. Its data is not a
client response, and credentials, command bodies, and hidden game information
must not be logged.

## Recovery information

Preserve enough information to restore the exact logical decision point:

| Information                                                                | Recovery purpose                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Session identity, occupied seats, readiness, and match identity and status | Distinguish restarting an existing session from initializing a fresh match.                            |
| Ruleset identity, version, configuration, and complete logical game state  | Restore the same rules and state, including established wall order and randomness-dependent decisions. |
| Hand and match progress, completed-hand results, and accumulated points    | Continue progression and retain earned results.                                                        |
| Open response round, requested seats, and accepted partial responses       | Continue collecting the same complete batch without forgetting accepted replies.                       |
| Published deadlines, pending fallback work, and intermission timing        | Resume timing and coordination consistently.                                                           |
| Pending stop request, target hand, and agreement                           | Preserve an approved pending stop or expire incomplete agreement at the correct boundary.              |
| Duplicate and stale-message recognition information                        | Avoid accepting the same transition twice or applying old replies to a new round or match.             |

The exact encodings, tables, receipt formats, and transaction APIs are not yet
chosen. This inventory records required logical information, not a database
schema.

## Restart and new match

A recreated runner restores the existing session, ruleset state, and pending
coordination. It must not reinterpret that restart as readiness for a fresh game.
Restore validates saved data and supported versions before use.

Once a match has ended, retain its terminal result. A unanimous stop takes effect
only after the current hand has completed and been scored; save those final
results and the terminated status before publishing completion. The stopped match
is not awaiting resumption.

A later match starts from fresh ruleset state under the same session ID after all
required seats ready again. Recording match points does not yet choose a lifetime
account balance or cross-session leaderboard.

## Open persistence decisions

- Checkpoint encoding, retained transition representation, schema, and transaction
  scope for gameplay and coordination records.
- Recovery after persistence succeeds but publication is interrupted.
- Deadline and fallback dispatch semantics under repeated delivery and restart.
- History retention, archive and deletion behavior, and receipt compaction.
- Deployment compatibility, migration, and rollback behavior for a replacement.

The initial end-to-end implementation should prove that a partially collected
round and pending stop agreement survive restart. Existing-format migration is
not implemented or specified by these documents.
