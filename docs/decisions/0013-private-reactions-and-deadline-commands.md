# ADR 0013: Persist private reactions and execute deadlines as commands

Status: accepted

Date: 2026-09-01

## Context

Milestone 5 adds simultaneous reactions and four kinds of operational deadline
to the authoritative `TableRoom`. Reaction choices must survive Durable Object
eviction, but publishing them, their eligibility, or revision changes would
leak concealed information. Cloudflare supplies only one alarm per Durable
Object and may deliver it more than once.

A player's response can arrive concurrently with another response or at the
same boundary as a timeout. Arrival order must not choose the Mahjong outcome,
and an alarm retry must not apply an action twice.

## Decision

Persist each reaction window and each actor's first valid intent in canonical
game state schema v2. An intent targets the stable window ID and the room
version at which it opened. Its authority-only
`game/reaction-intent-submitted` event, next canonical sequence/hash,
checkpoint, and actor-scoped receipt are atomic. It does not advance public
room `stateVersion` and causes no broadcast. A reconnecting actor may recover
only their own response status. SQL reaction tables are omitted; any future SQL
index must be derived from, verified against, and rebuildable from canonical
state and events rather than act as a second authority.

All three non-source seats are responders, even when pass is their only legal
choice. The first valid response is final. Invalid input is rejected without
creating an intent. Resolve after all three respond or at the eight-second
deadline; normalize absent responses to pass and sort responses in turn order.
The canonical resolution event contains the normalized set so replay can
recompute priority and winner selection without trusting arrival order. When
the third response also resolves the window, the same transaction appends the
ordered event batch `[game/reaction-intent-submitted,
game/reaction-resolved]`, hashes and reduces both events, updates one
checkpoint, records one resulting receipt, updates deadlines, and only then
publishes the resolved snapshot.

Use a persisted typed deadline queue to multiplex the Durable Object's one
platform alarm. Each deadline has a stable ID, exact target generation/sequence,
due time, and status. The alarm reads due items in `(dueAt, deadlineId)` order
and submits an explicit idempotent system command to the same authoritative
pipeline used by player actions. It never edits room or game state directly.
System-command receipts make duplicate delivery and retries no-ops.

Selected policy is 60 seconds for each connected turn decision, eight seconds
for reactions, 15 seconds with no valid socket for an actor before autopilot,
and 15 minutes with no valid socket anywhere at the table before recoverable
room abandonment. Presence requires a currently valid socket; a stored grant
alone is not presence. The connected turn deadline and disconnect grace are
independent.

At disconnect grace, the same canonical/system-command pipeline marks the
actor autopilot and immediately performs any currently actionable deterministic
work. Future autopilot turns act immediately. In `awaiting-draw`, timeout or
autopilot performs a compound head draw, recursive tail replacements, and
discard of the last-acquired structural tile. In `awaiting-discard`, it discards
the last-acquired remaining tile or the lowest canonical physical ID if none
remains. An outstanding reaction becomes canonical pass. Automation never
chooses a win or kong. Reconnect advances the connection generation, cancels
stale disconnect work, and clears autopilot, without undoing committed events.
Abandonment is room lifecycle, not wall exhaustion or deletion; a later valid
seated reconnect clears it and resumes persisted play.

Marking or clearing public autopilot/abandonment status is one viewer-visible
room transition and increments public room `stateVersion` once. Mere socket
churn remains connection-only and does not increment it.

At the race boundary, a player action whose authority-captured `now` is less
than `dueAt` passes the deadline race and receives normal validation. At or
after the deadline, due system commands run before the player command's version
check. Reconnect and new connection generations invalidate old disconnect
deadlines; table-wide presence generation invalidates stale abandonment
deadlines.

## Consequences

Private submissions are replayable, hash-linked canonical facts without
creating public-version or broadcast timing side-channels. A non-resolving
response receives a private receipt at the window's opening public version. A
final response that resolves the window receives the event batch's resulting
public version and the resolved snapshot after the transaction commits.

Every state transition that creates, cancels, or replaces a deadline updates the
queue with its authoritative state and receipt. Constructor recovery repairs the
earliest platform alarm from SQLite. Alarm, eviction, reconnect, exact-boundary,
and user-versus-timeout races require Workers-runtime fixtures.

Canonical intent and resolution events are authority-only and may contain
private or losing choices. They and their hashes must never be included in the
live viewer protocol or logs.
