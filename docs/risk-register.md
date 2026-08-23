# Risk register

Last reviewed: 2026-08-23

Owners are roles until contributors are assigned.

| ID | Risk | Likelihood | Impact | Mitigation and trigger | Owner |
| --- | --- | --- | --- | --- | --- |
| R-001 | “Hong Kong Mahjong” ambiguity causes rework or disputed scores | High | Critical | Maintain the executable decision register; block affected code at milestone rules gates | Product/rules |
| R-002 | Canonical events leak concealed tiles or reactions | Medium | Critical | Use separate domain and viewer message types; allowlist projection tests; snapshots first | Security/engine |
| R-003 | Discord proxy, CSP, iframe cookies, or mobile behavior differs from localhost | High | High | Run the deployed walking-skeleton spike before substantial engine work | Platform |
| R-004 | Hibernation/eviction loses in-memory state or connection identity | Medium | High | Persist all essential state, use socket attachments, and force eviction in tests at every phase | Platform |
| R-005 | Duplicate/reordered WebSocket commands or alarms apply twice | High | High | Global command IDs, receipts, expected versions, explicit system commands, idempotent handlers | Protocol |
| R-006 | Stored state becomes unreadable after deployment | Medium | Critical | Version payloads, transactional migrations, permanent oldest-format fixtures, deployment overlap policy | Storage |
| R-007 | `instanceId` binding is mistaken for persistent-table authorization | Medium | High | Explicit owner/invitation/resume policy; server authorization; unpredictable IDs | Security/product |
| R-008 | Reaction submissions create version or timing side channels | Medium | High | Decide private-intent persistence and acknowledgement semantics before M3; adversarial tests | Protocol/security |
| R-009 | Event hashes allow brute-forcing small hidden payloads | Medium | High | Do not publish raw hidden-event hashes live; blind/withhold commitments until reveal | Fairness/security |
| R-010 | Scoring decomposition or pattern exclusions become unreviewable | High | High | Fixture DSL, one rule per module, detected/awarded separation, validated interaction graph | Rules/engine |
| R-011 | Event log and receipts grow without bound | Medium | Medium | Define snapshot, archive, compaction, expiry, and deletion policy before full match history | Storage/product |
| R-012 | Mobile suspension misses turns or breaks sockets | High | Medium | Server deadlines, resync snapshots, grace policy, mobile smoke and soak tests | Client/platform |
| R-013 | Platform packages or constraints drift | High | Medium | Pin dependencies and compatibility date; re-check primary docs at each platform milestone | Platform |
| R-014 | Premature repository structure hardens wrong abstractions | Medium | Medium | Add packages/directories only with executable ownership; enforce boundaries as they appear | Architecture |
| R-015 | A player withholds committed shuffle entropy | Medium | Medium | Decide auditable abort or explicit fallback before collaborative fairness ships | Product/fairness |
| R-016 | OAuth access token and app session are conflated or retained unsafely | Medium | Critical | Model SDK authentication and app authorization separately; decide token lifetime, storage, rotation, and revocation in M1 | Security/platform |
| R-017 | Cross-object instance/table binding partially commits | Medium | High | Use an idempotent binding saga with intermediate states, proof, retry, expiry, and repair tests | Platform/storage |
| R-018 | Cached old clients connect to an incompatible Worker | High | High | Hash assets, negotiate current/previous protocol versions, and document rolling deploy/rollback | Protocol/platform |
| R-019 | Free-plan quotas interrupt active games | Medium | High | Treat Free as private alpha; monitor usage and define paid-plan promotion/budget alerts | Operations |
| R-020 | Logs capture hidden state or credentials | Medium | Critical | Allowlist structured fields and test emitted logs for private-data leakage | Security/operations |

## Review cadence

Review this register at each milestone boundary and whenever a rules, protocol, persistence, or platform assumption changes. A triggered risk becomes roadmap work with a named acceptance test or operational check.
