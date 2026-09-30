# ADR 0016: Coordinate human and bot controllers under one player identity

- Status: accepted
- Date: 2026-09-21

## Context

Persistent dedicated bots already use ordinary validated commands, but human
disconnect automation follows a separate deterministic path. Issue #33 brings
both command sources behind one player contract, preserving identity, seat,
hand, and committed history across a controller handoff. The engine continues
to know only player identities and Mahjong commands.

## Decision

`UserPlayer`, `BotPlayer`, and `PlayerCoordinator` implement the same typed
`Player` interface: receive permitted views and outcomes, publish typed command
envelopes, and dispose communication resources. `UserPlayer` adapts authorized
connections and exposes availability as an additional capability. `BotPlayer`
receives only its player's permitted game view. Its random policy can choose
any offered legal action, including wins and kongs.

The table owns one in-process coordinator per player. The coordinator routes
only the active controller's commands and outputs. It owns no authoritative
game state, transport, SQL, or timers. The room persists the active controller
and its monotonic generation before activating that route; it rechecks the
generation inside the authoritative mutation boundary. Revocation invalidates
queued callbacks and asynchronous bot results. A command committed before a
handoff remains accepted history.

Initial connection and reconnection deliver a fresh viewer-safe snapshot before
enabling commands from that connection. All authorized usable connections count
toward human availability. Losing or replacing one connection does not replace
the human while another remains usable. An explicitly departed connection
cannot reclaim control by remaining open; authorized reconnection must cross
the snapshot initialization boundary again.

### Liveness and controller policy

New clients request `heartbeat=1` on the protocol-v1 WebSocket URL. Supporting
Workers send `table/heartbeat-ready/1`; only after that negotiation does the
client send `table/heartbeat/1` every five seconds. A hibernation-compatible
WebSocket auto-response returns `table/heartbeat-ack/1`. Latest accepted heartbeat
evidence, or connection acceptance before the first heartbeat, remains usable
for 15 seconds, bounded by current authorization and session expiry. The room
checks liveness through its existing Durable Object alarm every five seconds.
Absence of gameplay input is never evidence of disconnection.

When every authorized connection becomes unusable, the existing 15-second
disconnect grace begins. Expiry activates a substitute `BotPlayer` under the
human's unchanged actor ID. A close, session replacement, or authorization
expiry follows this grace policy. Explicit active-hand departure revokes its
connection and changes control immediately if no other usable connection
remains, preserving the seat; lobby departure still vacates it.
Logout changes control immediately only when no other usable session remains.
There is no new leave/logout UI, readiness policy, or automatic-start policy.

Connected human turn deadlines retain their existing 60-second deterministic
timeout behavior. Reaction windows retain their eight-second timeout default
of pass. After substitution, bot work uses the normal random policy and 750 ms
move delay; this replaces the former disconnect autopilot's immediate
deterministic actions and automatic passes. Abandonment still pauses bot work,
and seated authorized reconnection can resume the retained hand.

Cached clients without heartbeat negotiation retain the native-open plus
authorization-expiry fallback. New clients connected to older Workers do not
send heartbeat frames without readiness, so the same fallback applies. This
fallback provides weaker detection of a silently half-open connection; it does
not infer health from gameplay inactivity.

### Persistence and compatibility

Storage schema v1 records player kind, active controller, and controller
generation. `bot_work` now references members, allowing all four original human
identities to be bot-controlled, and includes `controller_generation`.
Dedicated bot identities remain distinct membership kinds and retain their
existing seats and game identities. Pending work is reconciled with accepted
state and receipts in the same transaction. An unchanged target and generation
keep their command ID and deadline; a changed generation receives a fresh ID
even if the target is unchanged. Human restoration, terminal/submitted actions,
and abandonment cancel obsolete jobs.

Recovery reconstructs communication from validated storage and authorized
hibernating connections, repairs bot jobs and periodic health work, and schedules
the earliest alarm. The permanent complete-v1 fixture verifies recovery of
dedicated bots, pending jobs, and controller authority. Protocol-v1 snapshot and
receipt schemas include this behavior from the first release; heartbeat
support is negotiated outside those messages. A successful active-hand departure
uses terminal close code `4002` for heartbeat-negotiated connections; new clients
enter `stopped` and cancel heartbeat/reconnect work. The Worker uses the existing
terminal policy code `1008` for unnegotiated connections, keeping cached clients
from automatically reconnecting after departure. Ordinary `1000` closes remain
recoverable. See [ADR 0017](0017-prelaunch-v1-baseline.md) for the prelaunch
storage and protocol baseline.

## Worked operational examples

At time 0, a negotiated connection supplies heartbeat evidence. If no later
heartbeat arrives, its evidence expires at time 15 seconds. The periodic check
detects that expiry, and the 15-second disconnect grace precedes substitution.
A usable second authorized connection prevents takeover. These durations are
liveness evidence and grace, not a deadline based on the last Mahjong action.

A bot starts choosing for human actor `player-a` at controller generation 8.
An authorized reconnect restores human control at generation 9 and receives a
fresh snapshot before submitting. The generation-8 choice then completes; the
coordinator discards it before engine execution. A bot move committed before
generation 9 instead appears in that fresh snapshot. Neither case replaces the
actor, seat, hand, or prior game history.

## Consequences

This supersedes the disconnected-human autopilot portion of
[ADR 0013](0013-private-reactions-and-deadline-commands.md), while preserving its
turn/reaction deadlines and persistence/publication guarantees. It extends
[ADR 0015](0015-persistent-bot-players.md) to substitution. This is operational
table policy; `hong-kong/v1` legality, scoring, canonical encoding, and replay
semantics are unchanged. Bot strategy improvements and subsequent-hand
progression remain outside this change.
