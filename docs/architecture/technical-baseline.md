# Technical baseline

Last reviewed: 2026-08-23

## Runtime topology

```text
Discord Activity iframe / standalone mock client
└── React client
    ├── Discord adapter
    ├── HTTP session bootstrap
    ├── reconnecting table WebSocket
    └── local audit/verifier
         │
         ▼
Cloudflare Worker (same origin)
├── static assets
├── OAuth/session HTTP API
├── Discord REST integration
├── Activity instance resolution
└── WebSocket routing
     ├── ActivityInstance Durable Object
     │   └── live instance -> persistent table binding
     └── TableRoom Durable Object
         ├── authoritative game aggregate
         ├── viewer projection
         ├── hibernatable sockets
         ├── alarm/deadline dispatcher
         └── private SQLite storage
```

There is no separately hosted server, database, Redis, container, peer host, or WebRTC transport.

## Trust boundaries

The `TableRoom` is authoritative for command ordering, legality, wall order, concealed tiles, reactions, deadlines, scoring, and progression. The client is authoritative only for local selection, animation, preferences, and audit state.

Every external payload is untrusted, including Discord SDK values, OAuth inputs, cookies, WebSocket frames, serialized storage from an older deployment, and any client-computed legality or score.

The Worker must authenticate the application session and verify instance membership through Discord before granting table access. Knowledge of `tableId` is never authorization.

Discord has two adjacent authentication concerns that must not be conflated:

1. The Worker exchanges the authorization code and returns a short-lived Discord access token so the client can call `discordSdk.commands.authenticate`.
2. The Worker separately issues the application's cookie/session used for HTTP and WebSocket authorization.

The Activity Instance REST check requires a Discord bot credential. The product still has no companion-bot UX, commands, or continuously connected Gateway process, but the bot token is a required backend secret under the current Discord API.

The session design remains an explicit Milestone 1 decision: either a short-lived authenticated/encrypted cookie with key rotation and limited revocation, or an opaque cookie backed by durable server-side session storage. Both designs must specify expiry, revocation, OAuth token disposal/retention, CSRF defense, socket-origin validation, and revalidation after hibernation.

## Runtime-free domain boundary

Pure packages may depend on other pure packages through declared public entry points. They may not import React, Discord, Workers, Durable Objects, WebSocket, storage, process globals, the ambient clock, or ambient randomness.

The engine operations have separate responsibilities:

```text
decide(state, command, explicit context) -> domain events or violations
evolve(state, domain event)              -> next state
project(state, viewer)                   -> viewer-safe view
assertInvariants(state)                  -> invariant violations
```

Genesis semantics must be resolved before persistence: either creation emits replayable genesis events or a versioned genesis snapshot is an explicit replay root.

## Canonical events are not protocol messages

Persisted `DomainEvent` values may contain concealed draws, wall state, private choices, or scoring-search detail. They remain inside the authoritative boundary.

Clients receive only:

- A complete viewer-specific snapshot; or
- A separately defined viewer-safe delta produced for that viewer.

The first WebSocket milestone should prefer snapshots until projected deltas demonstrably reduce payload or UI complexity. A generic `ServerMessage<TDomainEvent, TView>` is prohibited because it makes an accidental hidden-event broadcast type-correct.

Reaction submissions need an explicit sequencing design before implementation. A private intent that changes canonical storage without producing a public transition must not leave other clients permanently stale or leak the choice through a supposedly public delta. The selected design must specify acknowledgement, replacement/finality, persistence, recovery, and version behavior.

`RoomState` owns access, membership, seats, lobby readiness, and table lifecycle. Rules-owned `GameState` begins only when a configured hand or match starts. Their event and revision relationship must be explicit; lobby concerns do not become Hong Kong rules events merely because both live in one Durable Object.

## Version semantics to decide before Milestone 3

| Version | Meaning | Compatibility rule |
| --- | --- | --- |
| `protocolVersion` | HTTP/WebSocket wire compatibility | Reject unsupported major versions; define a deployment overlap window |
| `rulesetVersion` | Exact semantic profile, such as `hong-kong/v1` | Historical matches remain pinned; semantic changes require a new version |
| `stateVersion` | Monotonic canonical aggregate transition position | Define whether it increments per event or atomic command before persistence ships |
| `viewVersion` | Optional viewer stream position if projected deltas are used | Must not expose or depend on hidden-only transitions |
| `storageSchemaVersion` | SQLite and serialized payload schema | Forward migrations are transactional and tested from permanent fixtures |
| `encodingVersion` | Canonical bytes used for hashes/commitments | Never reinterpret already committed bytes under new encoding rules |

Editorial clarification that does not change fixture outcomes does not require a new ruleset version. Any semantic fixture change does.

## Storage and recovery

The working model is an append-only event log plus an eagerly maintained current-state snapshot, command receipts, deadlines, and fairness records. Add a dedicated reaction-intent table if reaction choices are not canonical domain events.

An accepted state transition is one atomic storage operation:

1. Validate and authenticate.
2. Resolve an existing command receipt.
3. Check the expected version and command legality.
4. Decide and evolve using explicit time, IDs, and randomness.
5. Assert invariants.
6. Transactionally append events, write current state, write the receipt, and update deadlines.
7. Acknowledge and publish viewer projections only after persistence succeeds.

Durable Object construction/recovery must migrate storage, load the state, recover the earliest deadline, and rebuild live connection metadata from WebSocket attachments. Tests must exercise eviction during lobby, turn, reaction, and result phases.

WebSocket attachments stay small and contain only a connection identifier, authenticated actor identifier, session expiry, and connection generation. Socket closure destroys attachments, so they never hold connection-independent authority. Schema initialization uses `blockConcurrencyWhile` and a guarded schema version; constructor wake-up avoids full event replay when a valid current snapshot exists.

`ActivityInstance` and `TableRoom` cannot share a transaction. Binding therefore uses an idempotent saga with explicit intermediate state, a table-issued authorization proof, retries, and repair/expiry behavior for dangling mappings.

Event and receipt retention cannot be left indefinite. Before full-match history, choose snapshot cadence, compaction/archive rules, abandonment expiry, and deletion/export behavior.

Structured logging is allowlist-based. It must not serialize command bodies, cookies, OAuth tokens, seeds, walls, canonical state, projections, concealed tiles, reaction intents, or scoring search candidates.

## Deadlines

A persisted deadline queue multiplexes the object’s single alarm. The alarm reads all due items, submits explicit idempotent system commands to the same command pipeline, marks processed deadlines, and schedules the next one. It never edits game state directly.

Race tests cover user action versus timeout, duplicate alarm delivery, eviction before/after processing, clock skew at the boundary, and a newer connection replacing an older disconnect deadline.

## Fairness caveat

Deterministic shuffle, canonical encoding, and stable test vectors arrive with the draw/discard slice even though multiparty entropy arrives later.

Do not publish a live hash of a small hidden event payload: a concealed draw or reaction choice can be brute-forced. Canonical hidden-event hashes remain server-side during play or use a properly blinded commitment, then become auditable after reveal. Public-state verification uses a separate public transcript.

## Dependency direction

```text
game-core <- rules-hong-kong <- testkit
game-core <- protocol
game-core <- fairness

client -> package public contracts only
worker -> package public contracts and engine
packages -X-> apps
client -X-> worker source
worker -X-> client source
```

Within `rules-hong-kong`, the engine composes wall, hand, turns, claims, scoring, match, and invariant modules. Lower-level modules never import the engine or runtime adapters.

## Deployment compatibility and operating tier

Discord may cache non-HTML assets, so hashed asset names and explicit protocol negotiation are mandatory. During a rolling deployment, the Worker should support the current and immediately previous protocol version long enough for cached/connected clients to recover or reject with a clear upgrade response. Storage and engine rollout/rollback behavior must be documented before production data exists.

SQLite-backed Durable Objects are available on the Workers Free plan, but Free-plan request and storage budgets can interrupt service rather than transparently bill overage. Use Free for development/private alpha; define paid-plan promotion thresholds and budget alerts before availability is promised.

## Primary platform references

- [Discord Activity networking](https://docs.discord.com/developers/activities/development-guides/networking)
- [Discord multiplayer and Activity instances](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience)
- [Discord local Activity development](https://docs.discord.com/developers/activities/development-guides/local-development)
- [Discord Activity authentication tutorial](https://docs.discord.com/developers/activities/building-an-activity)
- [Discord production readiness and cache busting](https://docs.discord.com/developers/activities/development-guides/production-readiness)
- [Cloudflare Workers Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Cloudflare Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Durable Object testing](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [Cloudflare Workers pricing and Free-plan limits](https://developers.cloudflare.com/workers/platform/pricing/)
