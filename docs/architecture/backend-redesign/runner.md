# Game runner

The runner is the application coordinator in the
[backend redesign](README.md). It owns message ordering, readiness, response
collection, deadlines, lifecycle coordination, persistence, and publication. It
uses the [ruleset](ruleset.md) for gameplay decisions and communicates with
participants through [seat mailboxes](seat-mailboxes.md).

## Ownership

The runner tracks which seats must respond and waits for a complete response
batch. The ruleset determines eligible seats, move legality, competing-move
priority, and game outcomes. The runner does not interpret tile kinds, claim
ranks, or scoring rules.

The runner owns loading and saving through the [repository](repository.md).
It knows deadlines and mailbox identities, but does not observe player connection
status. WebSockets and reconnect behavior belong to the
[transport adapter](transport.md) behind the mailbox boundary.

## Match lifecycle

1. Participants occupy seats and submit ready messages for those seats.
2. When every required seat is occupied and ready, initialize and persist a fresh
   match under the session's existing identity.
3. Keep seat assignments fixed throughout the active match. A disconnected client
   retains its seat, and play continues through deadlines and fallback moves.
4. Publish each completed hand's results. The ruleset determines whether the match
   ends or continues and owns Mahjong progression decisions.
5. When continuing, publish the intermission deadline and start the next hand
   after the configured interval, initially five seconds. Participants are
   implicitly ready; another round of ready messages is unnecessary.
6. When the match ends normally or through an approved stop, persist its terminal
   status and results before publication.
7. The session may remain open. Participants can leave or ready for a fresh match,
   which starts once every required seat is occupied and ready again.

A new match starts fresh. A new runner instance restores the existing session,
match, and pending work instead of resetting the game.

## Gameplay response rounds

1. Consult the ruleset for eligible responding seats and their available moves.
2. Publish each seat's permitted view, available moves, and response deadline
   through its mailbox.
3. Validate each proposed gameplay move using the accepted ruleset state plus the
   proposed transition. Reject an invalid response immediately and allow that
   seat to retry until its original deadline.
4. Collect valid responses in an in-memory buffer. One response is required from
   each requested seat; permitted passes and mailbox fallback moves are responses
   too. Accepted partial responses must also be recoverable after restart.
5. Once all requested seats have responded, submit the complete batch to the
   ruleset. Obtain a candidate next state and semantic outcome.
6. Persist the accepted transition and related coordination changes atomically.
7. Adopt the candidate state in memory and publish permitted updates only after
   persistence succeeds. Then coordinate the next opportunities or lifecycle
   phase.

The runner orders incoming messages, recognizes retries, and rejects stale work.
Duplicate messages from one seat cannot count as responses from additional seats.
Exact message identifiers and duplicate-response behavior remain contract details
to define.

The accepted state remains unchanged when a save fails. Acceptance
acknowledgements and broadcasts that depend on a write follow successful
persistence.

## Deadlines

The runner publishes and tracks response deadlines. When a missing response's
deadline expires, it notifies that seat's mailbox that the deadline was exceeded
and requests a move immediately. The mailbox supplies a fallback through the
ordinary validation and response path.

The runner does not select the fallback or check whether the human client is
connected. Deadline and pending fallback work must be recoverable so a restart
can resume an incomplete round consistently.

## Stop after the current hand

A participant can request that the match stop after the current hand at any time
during that hand. Persist the request and immediately broadcast it to the seat
mailboxes so participants can agree while gameplay continues.

Stop requests and agreement are control messages. Process them independently of
an incomplete gameplay response batch; they do not replace a required gameplay
response. They still follow the runner's message ordering and persistence
discipline.

- Stopping requires unanimous agreement from the match participants.
- Unanimous agreement records a pending stop. The current hand continues normally.
- Finish and score the current hand before stopping.
- At the target hand boundary, persist the final results and mark an approved stop
  as a terminal match. Participants may then leave or ready for another match.
- At that boundary, expire any request without unanimous agreement together with
  its votes. A request does not carry into the next hand.
- Preserve the earned points as match results; the stopped match is not awaiting
  resumption.

Pending stop requests and votes survive restart. The five-second intermission is
not the only opportunity to collect agreement, since requests are broadcast
during the hand.

## Open contract details

- Response-round identifiers, duplicate and stale-message handling, and the race
  between a human response and a fallback response.
- How to advance the ruleset from a completed hand after the intermission.
- Stop-vote message shapes and the target boundary for a new request made during
  an already-completed hand's intermission.
- Recovery ordering and repeat publication after a committed write whose delivery
  was interrupted.

These are interface and persistence questions; this document does not select a
runtime class, queue implementation, or database schema.
