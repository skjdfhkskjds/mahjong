# Open technical and product decisions

Last reviewed: 2026-08-23

This register covers non-rules decisions. Game semantics belong in the Hong Kong rules decision register. `Recommended` is a starting position for review, not an accepted decision.

| ID | Decision | Recommended direction | Required by | Status |
| --- | --- | --- | --- | --- |
| TQ-001 | Application session design | Short-lived authenticated/encrypted cookie for the walking skeleton; retain Discord access token only in client memory; add server-side session generation/revocation only when the threat model requires it | M1 | open |
| TQ-002 | CSRF and socket authorization | Same-origin API, strict method/content-type checks, Origin validation compatible with Discord's proxy, short expiry, and authorization context rechecked on every message/wake | M1 | open |
| TQ-003 | Table create/join/resume | Cryptographically random table ID plus table-owned ACL and distinct expiring invitation/resume capability; do not rely on local storage or knowledge of ID | M2 | open |
| TQ-004 | Cross-object binding | Idempotent saga with table-issued proof, intermediate binding state, expiry, retry, and repair | M2 | recommended |
| TQ-005 | Duplicate live sessions | Newest connection generation replaces older connection for the same user/table, with an explicit `session/replaced` message | M3 | open |
| TQ-006 | Room/game aggregates | Keep `RoomState` and rules-owned `GameState` distinct; choose whether commits share one room revision while game events retain their own sequence | M3 | recommended |
| TQ-007 | Genesis/replay root | Versioned genesis snapshot plus replayable event tail; require byte-equivalent replay from the snapshot | M0B | open |
| TQ-008 | State version increments | One `stateVersion` per atomic accepted game-state transaction; store multiple event rows with an index within that version | M3 | open |
| TQ-009 | Private reaction persistence | Persist intents separately, target the window's opening revision, acknowledge privately, and advance public/game state only on resolution | M3/M5 | open |
| TQ-010 | Reaction response replacement | First valid response is final for v1 to simplify idempotency and player expectations | M5 | open |
| TQ-011 | Protocol deployment overlap | Support current and previous protocol major during a defined grace period; hash static asset filenames; explicit upgrade rejection outside the window | M3 | open |
| TQ-012 | Event/receipt retention | Preserve complete active-match history; snapshot at hand boundaries; define export, compaction, and deletion before full match history ships | M7 | open |
| TQ-013 | Logging policy | Allowlist identifiers, versions, event names, durations, and error codes; never serialize arbitrary payloads or state | M1 | recommended |
| TQ-014 | Cloudflare operating tier | Free plan for development/private alpha; move to Paid before availability commitments or measured usage approaches daily limits | M9 | recommended |
| TQ-015 | Public state update format | Viewer-specific snapshots after accepted mutations initially; add typed projected deltas only if measurement justifies them | M3 | recommended |
| TQ-016 | `messageId` purpose | Remove it unless transport-level correlation distinct from idempotent `commandId` has a concrete use case | M3 | recommended |

## Resolution process

When resolving an entry:

1. Record the selected option and rationale.
2. Link a new or existing ADR when the choice affects architecture or compatibility.
3. Add the acceptance test, fixture, or manual spike that proves it.
4. Mark it accepted only after the evidence exists.

