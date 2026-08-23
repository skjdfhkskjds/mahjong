# Architecture decision records

Accepted baseline decisions:

| ADR                                                     | Decision                                                             | Status   |
| ------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| [0001](0001-single-typescript-cloudflare-deployment.md) | Use one TypeScript monorepo and one Cloudflare deployment            | accepted |
| [0002](0002-one-table-room-per-persistent-table.md)     | Use one `TableRoom` Durable Object per persistent table              | accepted |
| [0003](0003-separate-activity-instance-from-table.md)   | Separate ephemeral Activity instances from persistent table identity | accepted |
| [0004](0004-server-authoritative-viewer-projected.md)   | Keep the server authoritative and send viewer-specific projections   | accepted |
| [0005](0005-command-event-reducer.md)                   | Use a pure command/event/reducer rules engine                        | accepted |
| [0006](0006-project-defined-hong-kong-v1-first.md)      | Implement a project-defined Hong Kong v1 profile first               | accepted |
| [0007](0007-no-peer-hosted-authority.md)                | Do not use peer-hosted authoritative gameplay                        | accepted |
| [0008](0008-json-genesis-snapshot.md)                   | Start replay from a JSON-safe versioned genesis snapshot             | accepted |
| [0009](0009-short-lived-signed-activity-session.md)     | Use a short-lived signed Activity session                            | accepted |
| [0010](0010-table-access-and-instance-binding.md)       | Keep table access separate from Activity instance binding            | accepted |
| [0011](0011-version-room-state-and-lobby-protocol.md)   | Version persistent room state and viewer-safe lobby messages         | accepted |

New ADRs use `NNNN-short-title.md` and contain context, decision, consequences, status, and date. Superseded ADRs remain in history and link to their replacement.
