# ADR 0015: Persistent bot players

- Status: accepted
- Date: 2026-09-20

## Context

Issue #21 began as local solo testing. The product requirement now includes
bots in normal Discord tables and browser play, including mixed human/bot
seating. A development-only runner cannot provide that behavior.

## Decision

The seated table owner may add up to three bots to vacant lobby seats and
remove those bots before a hand starts. Bots are visibly named, ready
immediately, and use reserved `bot:<uuid>` actor identities. Bot actors cannot
activate sessions or open sockets. The Worker owns their decisions and
submits ordinary validated game commands through the existing atomic
receipt/event/projection path.

The `random/v1` policy samples uniformly from the legal actions in the bot's
own viewer projection, including pass, claims, kongs, and wins. It sees no wall
or opponent hand and is independent of `hong-kong/v1` rules semantics. Bots
are distinct from disconnected-human autopilot. They are excluded from human
presence accounting and pause when the room is abandoned.

Storage schema v5 adds `bot_players` and `bot_work`. Pending work contains a
stable command ID, due time, and turn-sequence or reaction-window target.
The same SQLite transaction that accepts a command reconciles resulting bot
work. Durable Object alarms process human deadlines first and then at most
three due bot jobs. Recovery repairs the alarm from persisted work; stale
work is reconciled away. Private bot intent does not advance public state or
broadcast, and repeated delivery cannot submit the same intent twice.

Protocol v2 gains two closed commands with a seat: `lobby/add-bot` and
`lobby/remove-bot`. Snapshots/receipts remain unchanged. Old v2 clients can
read bot occupants; old Workers reject new bot commands. Deploy the Worker
and content-hashed client together. Schema v5 is forward-only: rollback must
understand v5 or restore the complete prior deployment and storage backup.
Permanent v1 and active-v3 fixtures remain, with a retained v4 schema fixture
proving migration without altering existing seats or lifecycle.

## Consequences

Solo play is supported without Discord accounts for opponents or browser
connections kept open on their behalf. The isolated browser launcher only
provides mock authentication and temporary storage; the feature itself has
no development flag. Strategic AI, difficulty settings, seat replacement
during a hand, and next-hand/match progression are outside this change.
