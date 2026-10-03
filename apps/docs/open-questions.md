# Open technical and product decisions

Last reviewed: 2026-09-01

This register covers non-rules decisions. Game semantics belong in the Hong Kong rules decision register. `Recommended` is a starting position for review, not an accepted decision.

| ID     | Decision                      | Recommended direction                                                                                                                                                                                                        | Required by | Status      |
| ------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------- |
| TQ-001 | Application session design    | Versioned one-hour HMAC cookie; memory-only Discord access token; current/previous signing-key rotation; per-actor/instance generation for replacement and revocation; see ADRs 0009/0010                                    | M1/M2       | accepted    |
| TQ-002 | CSRF and socket authorization | Exact-origin checks, strict media types, session-bound CSRF token for mutations, no permissive CORS, and bounded socket attachments whose expiry is checked on every message/wake                                            | M1          | accepted    |
| TQ-003 | Table create/join/resume      | Random table locator plus table ACL; owner-created actor-bound invitations; owner-only single-use resume capability; see ADR 0010                                                                                            | M2          | accepted    |
| TQ-004 | Cross-object binding          | Idempotent `unbound -> binding -> bound` saga with table-issued proof, operation receipt, deadline, retry, and opportunistic repair; see ADR 0010                                                                            | M2          | accepted    |
| TQ-005 | Duplicate live sessions       | Newest actor/instance session generation replaces older HTTP and socket authority; stale sockets receive `session/replaced` and close; see ADR 0010                                                                          | M2          | accepted    |
| TQ-006 | Room/game aggregates          | Keep `RoomState` and rules-owned `GameState` distinct; lobby room revision is separate from the future rules-event sequence; see ADR 0011                                                                                    | M3          | accepted    |
| TQ-007 | Genesis/replay root           | Versioned JSON-safe genesis snapshot fixed at event sequence zero, followed by an ordered replayable event tail                                                                                                              | M0B         | accepted    |
| TQ-008 | State version increments      | One `stateVersion` per atomic viewer-visible room transition; rejected, replayed, connection-only, and authority-only operations do not increment; see ADR 0011                                                              | M3          | accepted    |
| TQ-009 | Private reaction persistence  | Append each valid intent as an authority-only canonical event in v2 reaction state, advancing game sequence/hash/checkpoint but not public room `stateVersion` or broadcasts; SQL may only index derived facts; see ADR 0013 | M5          | accepted    |
| TQ-010 | Reaction response replacement | First valid response is final for `hong-kong/v1`; an invalid response does not consume the opportunity; see ADR 0013                                                                                                         | M5          | accepted    |
| TQ-011 | Protocol deployment overlap   | Because there was no external v1 deployment, atomically replace client and Worker with protocol v2, reject/close v1 requests, use hashed assets, and roll back both halves together; see ADR 0014                            | M3/M5       | accepted    |
| TQ-012 | Event/receipt retention       | Preserve complete active-match history; snapshot at hand boundaries; define export, compaction, and deletion before full match history ships                                                                                 | M7          | open        |
| TQ-013 | Logging policy                | Allowlist identifiers, versions, event names, durations, and error codes; never serialize arbitrary payloads or state                                                                                                        | M1          | recommended |
| TQ-014 | Cloudflare operating tier     | Free plan for development/private alpha; move to Paid before availability commitments or measured usage approaches daily limits                                                                                              | M9          | recommended |
| TQ-015 | Public state update format    | Send complete viewer-specific snapshots after accepted mutations; add separately typed projected deltas only if measurement justifies them; see ADR 0011                                                                     | M3          | accepted    |
| TQ-016 | `messageId` purpose           | Use only the idempotent `commandId`; no separate transport-level `messageId` exists; see ADR 0011                                                                                                                            | M3          | accepted    |
| TQ-017 | Deadline multiplexing         | Persist a typed deadline queue, use the one Durable Object alarm only as a wake-up, and process due work as explicit idempotent system commands; see ADR 0013                                                                | M5          | accepted    |
| TQ-018 | Canonical game upgrade        | Verify historical schema-v1 bytes, append a deterministic hash-linked upgrade event, and continue from canonical state schema v2 without rewriting history; see ADR 0014                                                     | M5          | accepted    |
| TQ-019 | Gameplay wire evolution       | Support only explicit protocol v2; absent, v1, and unsupported majors receive upgrade-required and close, with no dual reader or overlap modules/tests; see ADR 0014                                                         | M5/M6       | accepted    |

## Resolution process

When resolving an entry:

1. Record the selected option and rationale.
2. Link a new or existing ADR when the choice affects architecture or compatibility.
3. Add the acceptance test, fixture, or manual spike that proves it.
4. Mark it accepted only after the evidence exists.
