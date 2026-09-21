# Discord Activity application

This application is the single deployable React client and Cloudflare Worker. The Worker serves the SPA, exposes the same-origin HTTP API, and routes authenticated WebSockets to a SQLite-backed `TableRoom` Durable Object.

## Boundaries

- `src/client` owns React, the Embedded App SDK adapter, browser transport, and presentation state.
- `src/worker` owns HTTP authentication, request policy, platform integrations, and Durable Objects.
- Client and Worker source may import pure packages through public exports but may not import one another.
- The WebSocket carries runtime-validated protocol-v2 lobby/game commands,
  actor-scoped receipts, and viewer-safe snapshots only. The Worker remains the
  authority for game creation, ordering, private reactions, deadlines, and
  scored completion.

### Client presentation and feature controllers

`features/lobby/LobbyController` and `features/gameplay/GameController` adapt
validated viewer snapshots into display props and semantic callbacks for
`LobbyPanel` and `GamePanel`. The panels receive labels, structured tile kinds,
public player information, result summaries, and available controls; they can
render with display fixtures and callback spies without a socket. They do not
consume receipts or construct protocol commands.

The feature layer owns phase/status text, grouping the server's exact actions,
seat/readiness hints, receipt feedback, and local reaction submission state.
An accepted private reaction stays pending until the next projection; a rejected
receipt, changed window, disconnect, or replacement snapshot releases the local
hint. The server's submitted reaction status then takes precedence. A local
deadline only disables controls and displays “waiting for the server outcome”;
it never advances the game. Server snapshots remain the source of truth after
reconnect or rejection.

Application wiring owns authentication, command IDs, expected state versions,
and command envelopes. Transport owns serialization, runtime wire/result
validation, and socket lifecycle. The Worker and rules engine retain all move
legality, start permissions, authoritative deadlines, and scoring decisions.
Client readiness/ownership checks are usability hints and cannot grant authority.

The player-identity feature mapper interprets the reserved dedicated-bot actor
namespace and supplies `human`/`bot` display kinds to lobby and gameplay.
Temporary autopilot never changes a human's identity. The lobby controller maps
the session-owner hint to add/remove-bot callbacks; owner spectators and
disconnected owners see those controls disabled. Bot occupancy and readiness
remain snapshot-owned, including after rejection or reconnect.

For example, a concealed-kong control starts with an exact action already offered
by the server. The gameplay mapper creates a labeled choice with an opaque ID;
the panel emits `onConcealedKong(choiceId)`. The feature callback looks up that
offered action and passes its typed command to application wiring, which adds
the current version and command ID before transport sends it. Add mapper tests
for the choice and command, then a panel test using display props and a callback
spy. Any new rules or wire behavior requires its own domain/protocol work.

## Standalone development

From the repository root:

```text
corepack pnpm app:dev
```

The committed Wrangler variables run the Worker in mock mode with a development-only signing key. Open the printed localhost URL. The client creates a server-assigned mock identity, receives an instance-scoped application session, resolves an unpredictable persistent table through `ActivityInstance`, and connects without supplying a table ID. No Discord or Cloudflare credentials are required.

Optional browser configuration belongs in an ignored `.env.local` copied from `.env.example`.

The client and Worker modes must match. If a `.dev.vars` file exists from Discord-proxy development, either remove it for the committed mock defaults or set these non-secret values while working on localhost:

```text
APP_MODE=mock
SESSION_COOKIE_NAME=mahjong_session
```

Set `VITE_ACTIVITY_MODE=mock` in `.env.local`. A mock cookie must not use the `__Host-` name because mock mode deliberately serves it without the production-only `Secure` attribute.

For deterministic local UI evidence, append `?localEvidence=gameplay` while the
Vite server is running in development mock mode. This page feeds only strict,
allowlisted protocol-v2 viewer snapshots through the production parser and real
gameplay presentation controls. It is not an authority simulator and cannot
expose a wall, opponent hand, canonical event, or hash. The explicit
development guard and lazy import remove its marker and fixture bytes from the
production bundle.

## Playing with bots

Bots are a normal table feature in both Discord and the standalone browser.
The table owner claims a seat, selects **Add bot** on each empty seat, marks
themselves ready, and selects **Start hand** once all four seats are ready.
Add one to three bots to play with friends or alone. Bots are ready immediately;
the owner can select **Remove bot** before the hand starts to make room for a
human player. Seats cannot be replaced during a hand.

Bots choose random legal actions, including claims, passes, kongs, and wins.
They have no strategic difficulty setting. The Worker makes each decision from
that bot's own viewer projection and schedules it about 750 ms after an action
becomes available. Private reactions stay private until resolution. Bot
identities and pending work persist across browser reloads, disconnection, and
Durable Object eviction; bots do not need Discord accounts or client sockets.
Existing human timeout/reconnect rules apply. Bots do not keep an otherwise
empty room alive: abandonment pauses their work until a seated human returns.

For a quick browser session without changing your Discord credentials, run:

```text
corepack pnpm app:dev:solo
```

Open the printed local URL and use the same **Add bot** controls. This launcher
uses mock authentication and temporary storage with the production bot
implementation. It ignores local Discord credentials and browser API/mode
overrides. Restarting the launcher creates a fresh table; normal `app:dev`
uses persistent local storage. Keep the same origin and browser profile while
playing. Mock sessions retain the existing one-hour lifetime. Next-hand and
match progression remain separate Milestone 7 work.

## Discord-proxied development

1. Create a Discord application and enable Activities.
2. Put the public client ID in `.env.local` and set `VITE_ACTIVITY_MODE=discord`.
3. Copy `.dev.vars.example` to the ignored `.dev.vars` and provide the Discord client secret, bot token, and at least 32 random bytes for the current session signing key. The example already selects Discord mode, the required `__Host-mahjong_session` cookie name, and the one-hour maximum session lifetime.
4. Confirm `.env.local` uses `VITE_ACTIVITY_MODE=discord`; it must match `APP_MODE=discord` in `.dev.vars`.
5. Run `corepack pnpm app:dev`.
6. Expose the printed local origin with `cloudflared tunnel --url <local-origin>` and configure that HTTPS target in the Discord Developer Portal URL mapping.
7. Launch the Activity through Discord and verify SDK authentication, the partitioned cookie, and WebSocket behavior on desktop/web and mobile.

Never commit `.env.local`, `.dev.vars`, the client secret, bot token, or signing keys. The Discord bot credential is used only for backend Activity Instance verification; there is no Gateway process or companion-bot UX.

## Table access API

The first verified actor in a new Activity instance becomes the table owner. A verified instance discovers a table but does not make every participant a table member.

- `POST /api/table/invitations` accepts an `invitedActorId` and returns an owner-created, actor-bound invitation once.
- `POST /api/table/invitations/redeem` consumes that invitation for the signed-in actor.
- `POST /api/table/resume-capabilities` returns an owner-only, short-lived capability once.
- A fresh Discord exchange may include that value as `resumeCapability`; the server verifies the new instance before rebinding the existing table.
- `POST /api/session/logout` advances the actor's server-side session generation and clears the cookie.

Authenticated session responses report `access: "member"` with an owner/member `role`, or `access: "join-required"` without a role. Join-required clients do not open a table socket until an actor-bound invitation has been redeemed. Invitation and resume capability strings are intended for direct, out-of-band delivery; do not put them in URLs, storage, or logs.

All authenticated mutations require exact origin, JSON, and the current session's `X-CSRF-Token`. Table and capability identifiers are never authorization on their own.

## Table WebSocket protocol

The client connects to `/api/table/socket?protocolVersion=2`. An absent,
duplicate, version-1, or unsupported major version is rejected before gameplay
messages are accepted. There is no live dual-reader window because no earlier
protocol was externally deployed.

An authorized socket receives a complete viewer-specific snapshot containing
four ordered seats, persistent occupants and ready state, spectators, the
viewer's role, and the current room `stateVersion`. During play it adds public
melds, discards, bonuses, turn/deadline state, only the seated viewer's hand and
exact actions, and a structured terminal score. Lobby and game commands use a
closed protocol-v2 envelope carrying a bounded `commandId` and the snapshot
version it acted on.

Accepted room transitions commit their SQLite mutation and actor-scoped receipt atomically, increment `stateVersion` once, and then broadcast a freshly projected snapshot to each current viewer. An identical retry by the same actor returns the stored receipt without applying twice. A stale version returns a rejection plus a fresh snapshot; command-ID collisions return a generic rejection without exposing the original actor or command.

Private reaction submissions append a canonical hash-linked event and
actor-scoped receipt without changing public `stateVersion` or broadcasting.
Resolution persists the final intent and normalized outcome atomically, then
publishes one viewer-safe transition. Seats are actor reservations, not socket
presence. They survive disconnect, hibernation, and Durable Object eviction.
Leaving the lobby vacates the seat; explicit departure during an active hand
preserves the actor, seat, and hand while a bot takes control. WebSocket attachments retain only bounded
connection/session identity; room/game authority, deadlines, revisions, and
receipts remain in SQLite.

### Client connection lifecycle

The browser owns one native WebSocket at a time. Every authorized initial,
retried, or explicitly restarted connection follows the same path:
`connecting` → `awaiting-snapshot` → `connected`. Opening the socket alone
never enables commands. Each open requests `table/resync` using the last
received snapshot revision (zero for a new run), and the existing server also
sends a fresh viewer-specific snapshot on authorization. Either fresh snapshot
satisfies initialization; the client does not reconstruct state from history.
Receipts alone cannot complete initialization, including private reaction
receipts that share the current public revision.

The client advertises `heartbeat=1` and starts one run-owned heartbeat only
after the server's exact `table/heartbeat-ready/1` frame. The inherited heartbeat
helper sends transport-only pings every five seconds and bounds the oldest
unacknowledged ping to fifteen seconds. Ready and acknowledgement frames pass
through the same ordered connection guard as table messages, but do not enter
application subscriptions or satisfy snapshot synchronization. Older Workers
that omit the ready frame retain the legacy connection behavior. Stop, retry,
terminal control, departure, and transport error cancel heartbeat timers;
native closing handshakes retain their actual terminal close semantics.

`SocketStatus` contains only lifecycle data. Connecting, waiting, and
interrupted states carry attempt data; `reconnecting` additionally carries the
bounded retry delay. A transport error enters `disconnecting` while awaiting
the close code, preserving authorization/replacement/upgrade close semantics.
An ordinary close retires listeners and schedules a retry. Authentication,
replacement, upgrade, malformed protocol, and explicit stop are terminal for
that run. A deliberate active-hand departure closes with application code
`4002` on negotiated connections, which enters `stopped` and never retries
automatically. The legacy `1008` departure fallback is also terminal. A new
explicit startup may reconnect and must receive a fresh snapshot; normal close
`1000` retains transient retry behavior. The application clears its snapshot
and receipt whenever connection usability is lost. Only `connected` permits a validated command send, and no
command is queued or automatically replayed.

`subscribe(type, listener)` derives each callback payload from the existing
validated wire union. A single synchronous queue preserves message arrival
order across all types, including reentrant callbacks. A fresh initialization
snapshot is delivered to application subscribers before the `connected`
lifecycle notification enables controls. Subsequent receipts and snapshots are
delivered in wire order even when their public revisions are equal. Terminal
control messages first change lifecycle state and retire the socket, then reach
control subscribers. A callback that stops or replaces the run cancels the
remaining delivery for that run. Subscriber exceptions are isolated, never
classified as malformed wire data, and never logged with message contents.

The `start` callback observes lifecycle changes only. Starting again retires
the previous run; its old stop handle and socket callbacks cannot affect the
new run. Message subscriptions survive stops/restarts until their returned
unsubscribe function is called; application disposal removes them and stops
the run. Unsubscribe takes effect during an in-progress delivery. The startup
feature owns the current snapshot and receipt; feature controllers own command
interpretation and pending UI state.

This client refactor leaves protocol v2, server authorization/snapshot behavior,
and persisted formats unchanged. Existing client and server v2 deployments
remain wire compatible; no new deployment overlap or migration is required.

Schema v6 adds persisted player/controller generations and generation-bound
bot work for both dedicated bots and substituted humans. It retains the permanent migration roots
`tests/fixtures/table-room-v1-schema.ts` and
`tests/fixtures/table-room-v3-active-v1-game.ts`, plus the pre-bot
`tests/fixtures/table-room-v4-schema.ts` and the pre-coordinator
`tests/fixtures/table-room-v5-schema.ts`. The active-game fixture verifies its
historical v1 hash chain, appends one explicit state-upgrade event, and
continues play as canonical state v2.

## Controller handoff and connection health

The same `Player` communication contract connects `UserPlayer`, `BotPlayer`,
and an in-process `PlayerCoordinator` to the authoritative table. Controller
changes preserve the player identity, seat, hand, and accepted history. The
coordinator rejects commands and asynchronous bot results from an obsolete
controller generation. Reconnection delivers the player's fresh permitted
snapshot before enabling human commands.

New clients negotiate heartbeats with `heartbeat=1` on the WebSocket URL. After
`table/heartbeat-ready/1`, they send `table/heartbeat/1` every five seconds;
the Worker's hibernation auto-response returns `table/heartbeat-ack/1`. Connection
acceptance or the latest heartbeat supplies 15 seconds of liveness evidence,
bounded by authorization/session expiry. A five-second Durable Object alarm
checks all authorized connections. After the final usable connection expires
or closes, the existing 15-second grace precedes substitution. Lack of game
input does not imply disconnection. Another usable connection prevents takeover.

Explicit active-hand departure revokes the departing connection and substitutes
immediately when no other usable connection remains. Logout does so only
when no other usable session remains. Connected-turn timeouts retain their
60-second deterministic policy; a substitute then uses ordinary random legal
bot actions, including claims, wins, and kongs, at the 750 ms bot delay.
No new readiness, automatic-start, or leave/logout UI is introduced.

## Verification

```text
corepack pnpm app:build
corepack pnpm check
```

Worker types are compatibility-date-aware and generated from `wrangler.jsonc`:

```text
corepack pnpm --filter @mahjong/discord-activity run types:worker
```

Regenerate them whenever bindings, compatibility date, or flags change.

## Deployment

Protocol v2 is an atomic client/Worker release. The Worker serves
content-hashed client assets from the same deployment, so rollout replaces both
wire endpoints together and rollback restores both together. Do not roll back
only the Worker or reuse an older HTML shell with a newer Worker. Storage schema
v6 remains forward-only across a code rollback; use the previous release only
if it understands schema v6, otherwise restore the complete pre-migration
deployment and storage backup rather than attempting to reinterpret v6 rows.

Bot management adds `lobby/add-bot` and `lobby/remove-bot` commands with a
`seat` field to protocol v2; the snapshot and receipt shapes are unchanged.
Older v2 clients can observe and play at bot tables. A newer client cannot
manage bots against an older Worker, which rejects the unknown commands, so
ship bot controls and Worker support together. Existing tables migrate to v6
without changing seats, game events, or hashes. Schema v6 changes `bot_work` to
reference members and adds `controller_generation`; the retained v5 fixture
covers existing bots and pending work. Rollback to pre-coordinator code needs
the complete pre-migration backup because that code rejects schema v6.

Heartbeat negotiation permits cached protocol-v2 clients during rollout.
Clients without `heartbeat=1` use native-open plus authorization-expiry
evidence. A new client does not send heartbeat frames until the Worker sends
readiness, so an older Worker continues using that same fallback. Its silent
half-open detection is weaker than negotiated heartbeat health. Successful
active-hand departure closes negotiated connections with `4002`, which new
clients treat as terminal `stopped`. Connections without heartbeat negotiation
receive the existing terminal policy close `1008`, so cached clients also stop
instead of reconnecting and undoing their departure. Ordinary `1000` closes
remain recoverable. Existing snapshot and receipt shapes are unchanged. See
[ADR 0016](../../docs/decisions/0016-player-controller-lifecycle.md) for controller
policy, recovery, and operational examples, and
[ADR 0015](../../docs/decisions/0015-persistent-bot-players.md) for dedicated bots.

The production command fails before building unless `VITE_ACTIVITY_MODE=discord` and a valid `VITE_DISCORD_CLIENT_ID` are present. The production Wrangler environment does not inherit the committed mock signing key.

Provision Worker secrets before the first deployment:

```text
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put DISCORD_CLIENT_ID --env production
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put DISCORD_CLIENT_SECRET --env production
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put DISCORD_BOT_TOKEN --env production
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put SESSION_SIGNING_KEY --env production
```

Only provision `SESSION_SIGNING_KEY_PREVIOUS` during an active signing-key rotation. Then run `corepack pnpm --filter @mahjong/discord-activity deploy`. Deployment is intentionally manual and credential-gated; local implementation and tests never invoke it.
