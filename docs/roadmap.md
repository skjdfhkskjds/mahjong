# Implementation roadmap

Last reviewed: 2026-08-23

## Goal and release boundary

Build a private four-player Discord Activity for the project-defined `hong-kong/v1` profile. The authoritative table lives in one SQLite-backed `TableRoom` Durable Object; a separate `ActivityInstance` Durable Object binds a live Discord Activity instance to a persistent table. One Worker serves the React client, HTTP API, OAuth exchange, and WebSocket routing.

Japanese Mahjong is a future rules package. No Japanese package or universal cross-variant state object will be created in advance.

## Planning principles

1. Implement vertical slices that retire architectural risk early.
2. Treat rules as versioned, testable product decisions.
3. Separate canonical domain events from viewer-safe protocol messages.
4. Supply time, identifiers, and randomness to the pure engine explicitly.
5. Persist accepted transitions before acknowledging or broadcasting them.
6. Preserve permanent replay and migration fixtures from the first stored schema.
7. Add structure when ownership is real; do not generate the entire proposed tree up front.

## Status legend

- `not started`: no implementation work has begun.
- `in progress`: work is active and exit evidence is incomplete.
- `blocked`: a named external decision or dependency prevents progress.
- `complete`: every exit criterion has recorded evidence.

## Milestone 0A — Planning and decision inventory

Status: in progress

Deliverables:

- Repository roadmap, risk register, testing strategy, and contribution rules.
- Architecture baseline and trust boundaries.
- `hong-kong/v1` rules decision register with provenance and compatibility impact.
- Explicit distinction between rules semantics and operational table policy.
- ADR template and initial ADRs when code-facing choices are accepted.

Exit criteria:

- Every known rules decision axis is recorded.
- Decisions needed for the next milestone are accepted; later decisions may remain open with a required-by gate.
- No planned behavior relies on an undocumented default.
- Major technical risks have a mitigation and trigger.

## Milestone 0B — Repository and pure-domain contract

Status: not started

Deliverables:

- pnpm workspace with pinned Node and pnpm versions.
- Strict TypeScript, formatting, linting, package export checks, and mechanical import-boundary checks.
- Minimal `game-core` types: branded identifiers, physical tile identity, common tile concepts that are truly variant-neutral, seats, winds, viewer, engine decision, and invariant violations.
- Rules-engine contract with explicit genesis/replay semantics.
- Initial Hong Kong profile schema covering settled draw/discard behavior.
- Fast required CI checks, including Conventional Commit and PR-title validation.

Exit criteria:

- `typecheck`, `lint`, `format:check`, `test`, and boundary checks pass in CI.
- No platform imports exist in pure packages.
- Core types do not encode unresolved bonus, meld, or Japanese-specific behavior.
- A persisted history has a defined replay root: either genesis events or a versioned genesis snapshot.
- One worked example covers setup, deal, bonus replacement, draw/discard, and wall exhaustion under accepted rules.

## Milestone 1 — Deployed walking skeleton

Status: not started

This deliberately precedes substantial engine work because Discord proxy, iframe cookie, OAuth, CSP, WebSocket, and hibernation behavior are high-risk integration points.

Deliverables:

- React/Vite frontend and Worker API in one Cloudflare deployment.
- `/api/health` and a static page.
- Real and mock Discord bridges.
- Minimal OAuth identify flow that returns the short-lived Discord access token needed by `discordSdk.commands.authenticate`, then issues a separate secure application session for app API/WebSocket authorization.
- An explicit session design covering storage/statelessness, expiry, revocation, key rotation, OAuth token retention, CSRF, socket-origin checks, and per-message revalidation.
- One hibernatable Durable Object WebSocket carrying mock table state.
- Standalone local mode and a documented Discord-proxied tunnel workflow.

Exit criteria:

- Static assets and API work through one Activity origin.
- The Activity loads through Discord desktop/web and one mobile client.
- A backend-issued session survives iframe requests using the documented cookie attributes.
- Discord SDK authentication completes with the exchanged short-lived access token without treating that token as the long-lived app session.
- A WebSocket reconnects and resynchronizes after simulated hibernation/eviction.
- Mock mode works without Discord credentials.

## Milestone 2 — Identity, table access, and instance binding

Status: not started

Deliverables:

- Worker-side Discord code exchange and trusted user lookup.
- Activity Instance API verification that the authenticated user belongs to the supplied instance.
- A Discord bot credential used only for required backend API authorization; “no companion bot” means no bot UX, commands, or Gateway process, not no bot token.
- Session expiry, rotation/revocation, duplicate-session, and replacement policy.
- Persistent `instanceId -> tableId` binding in `ActivityInstance`.
- An idempotent cross-object binding saga (`unbound -> binding -> bound`) with repair behavior, because transactions cannot span `ActivityInstance` and `TableRoom` objects.
- Table creation, ownership, invitation/join, resume, and rebinding policy.
- Unpredictable public table identifiers plus server-side authorization.

Exit criteria:

- Users in one valid Activity instance resolve to one table.
- Different instances do not collide.
- A resumed table can bind to a new instance only through an authorized flow.
- Invalid, expired, or mismatched users and instances are rejected.
- No browser-provided Discord identity or instance metadata is trusted without server verification.

## Milestone 3 — Persistent lobby and viewer-safe protocol

Status: not started

Deliverables:

- `TableRoom` SQLite schema and migrations.
- Hibernatable WebSocket association via serialized connection attachments.
- Four exclusive seats, spectators, ready state, seat reservation, and reconnect behavior.
- Runtime-validated command envelopes, idempotent receipts, stale-version recovery, and snapshots.
- Explicit version semantics for protocol, ruleset, canonical state, storage, and viewer messages.
- Separate canonical `DomainEvent` and viewer-safe `ViewDelta`/snapshot types.
- Separate room state (access, membership, seats, lobby, lifecycle) from rules-owned game state, with revision semantics documented for both.
- Command collision rules: replay by the same authenticated actor returns that actor's receipt; reuse by another actor is rejected without disclosing the original response.

Exit criteria:

- Four users occupy distinct seats; additional users spectate.
- Seat ownership and ready state survive reconnect and forced eviction.
- Duplicate commands and duplicate sessions cannot apply an action twice.
- A stale client receives a fresh viewer-specific snapshot.
- Tests prove no canonical event or hidden canonical state crosses the socket boundary.
- The oldest committed schema fixture loads under current code.
- WebSocket attachments contain only bounded connection identity, actor identity, session expiry, and connection generation; all authoritative data remains in SQLite.

## Milestone 4 — Hidden-state draw/discard vertical slice

Status: not started

Rules gate: tile set, deal, bonus replacement order, wall/dead-wall exhaustion, initial dealer turn, and draw/discard behavior must be accepted in the rules register.

Deliverables:

- Deterministic tile-set construction and shuffle with fixed cross-runtime vectors.
- Initial deal, bonus exposure and replacement, dealer discard, ordinary draw/discard.
- Player and spectator projections.
- Tile conservation, hand-size, phase, duplicate-ID, replay, and serialization invariants.
- Canonical encoding and event-hash format decided now, even if multiparty entropy remains later.

Exit criteria:

- Four players receive distinct private hands and spectators receive none.
- Projection noninterference tests prevent hidden-state leakage.
- Every physical tile is in exactly one valid location after every event.
- Scripted and seeded-random games complete many draw/discard turns.
- Event replay reproduces byte-equivalent canonical state.
- Disconnect/reconnect and forced eviction preserve the game.

This is the first meaningful product milestone.

## Milestone 5 — Claims, kongs, and deadlines

Status: not started

Rules gate: claim priority, tie-breaking, multiple winners, all kong forms, robbing behavior, passed-win behavior, and exhaustion boundaries must be accepted.

Deliverables:

- Legal reaction calculation and private prompts.
- Persisted reaction windows and player intents.
- Deterministic resolution independent of arrival order.
- Pass, chow, pung, kong, and provisional win intentions.
- Alarm-backed turn, reaction, disconnect, and abandonment deadlines.
- Explicit system commands for every timeout; alarm handlers never mutate game state directly.

Exit criteria:

- All eligible-response permutations resolve identically.
- Higher-priority claims override earlier lower-priority submissions.
- Timeout and alarm retry tests are idempotent immediately before, at, and after deadlines.
- Kong replacement and robbing transitions conserve tiles.
- Eviction during an open reaction window preserves all committed intents without disclosing them.

## Milestone 6 — Winning hands and scoring

Status: not started

Rules gate: the pattern catalog, special hands, stacking/supersession graph, minimum fan, cap/limits, payments, and responsibility rules must be accepted.

Deliverables:

- Standard and supported special-hand recognition.
- Enumeration of valid decompositions and best legal score selection.
- Separate detected-pattern and awarded-pattern sets.
- Validated pattern implication/exclusion graph.
- Explainable score and payment breakdown.
- Compact fixture DSL containing physical tiles, winning source, meld history, winds, bonuses, kong history, and expected payments.

Exit criteria:

- Each accepted rule maps to positive, near-miss, interaction, and payment fixtures as applicable.
- Ambiguous hands select the highest legal score.
- Metamorphic tests preserve results across irrelevant tile-copy, ordering, and seat-rotation changes.
- The server never offers an illegal win action.
- Score explanations exactly reproduce payments.

## Milestone 7 — Match progression and history

Status: not started

Rules gate: dealer continuation, draw handling, round advancement, match length, termination, and balance rules must be accepted.

Deliverables:

- Hand results, dealer/round progression, balances, exhaustive draws, match completion, and replayable hand history.
- Version-pinned historical rules and storage compatibility.
- Retention, archive/export, receipt compaction, and abandoned-table cleanup policy.

Exit criteria:

- Four players complete a configured match under `hong-kong/v1`.
- Restart and eviction preserve match state.
- Historical fixtures retain original rules semantics across deployments.
- Storage growth remains within the documented retention budget.

## Milestone 8 — Collaborative fairness and audit

Status: not started

Rules/policy gate: missing or withheld entropy behavior must be accepted.

Deliverables:

- Server-first seed commitment, player commitments and reveals, HKDF combination, deterministic shuffle, wall commitment, and post-hand transcript.
- Browser verifier for public transitions, score, payments, and shuffle reconstruction.
- Canonical event hash chain with hidden-event commitments withheld or blinded during play to prevent brute-force disclosure.

Exit criteria:

- Every participant reconstructs the wall after reveal.
- Modifying a seed, tile, event, or score fails verification.
- No seed, wall position, or brute-forceable hidden-event hash is disclosed during play.
- Missing contributions follow the recorded abort/fallback policy.

## Milestone 9 — Production hardening

Status: not started

Deliverables:

- Responsive landscape and mobile layouts, safe areas, accessible input, reduced motion, and confirm-before-discard.
- Reconnect behavior for mobile suspension.
- Rate limits, request size limits, structured logs, metrics, error reporting, security headers, secret rotation, and dependency scanning.
- Allowlist-based logging with automated checks that commands, seeds, cookies, canonical state, and private projections are never logged.
- Release deployment, Discord metadata, rollback/runbook, and platform smoke tests.
- Paid-plan transition criteria and budget alerts; the Free plan is a development/private-alpha target, not an availability guarantee.

Exit criteria:

- Desktop, web, Android, and iOS layouts are usable.
- Reconnect storms and delayed/duplicated messages pass soak tests.
- Automated privacy, recovery, migration, and security checks pass.
- Deployment and rollback require no manually operated game server.

## Future milestone — Japanese rules

Only after Hong Kong matches are reliable, add `rules-japanese` and a ruleset registry at the application composition boundary. The UI consumes ruleset-supplied view and legal-action contracts; it must not accumulate scattered ruleset-name branches.

## Evidence policy

Every completed milestone must link to automated tests or recorded manual evidence for each exit criterion. Across milestones, the recurring gates are determinism, idempotency, projection privacy, eviction recovery, persisted-fixture compatibility, and documented failure behavior.

## Platform baseline verified on 2026-08-23

- Discord Activities remain iframe-hosted behind a proxy; WebSockets are supported and WebRTC is not.
- Discord documents `SameSite=None` and `Partitioned` for Activity cookies and warns not to trust client-provided Discord data.
- Discord exposes `instanceId` immediately after SDK construction and recommends backend Activity Instance verification.
- Discord's current authentication flow still requires returning the exchanged short-lived access token to `discordSdk.commands.authenticate`; the application cookie is a separate credential.
- Cloudflare recommends the Hibernation WebSocket API and SQLite-backed Durable Objects; one alarm per object requires a persisted deadline queue.
- The current Workers test integration package is `@cloudflare/vitest-plugin` (renamed from `@cloudflare/vitest-pool-workers` in August 2026).

Re-check these claims against primary documentation when Milestone 1 begins because platform behavior and package APIs can change.
