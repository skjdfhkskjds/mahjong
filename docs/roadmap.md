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

Status: complete

Deliverables:

- Repository roadmap, risk register, testing strategy, and contribution rules.
- Architecture baseline and trust boundaries.
- `hong-kong/v1` rules decision register with provenance and compatibility impact.
- Explicit distinction between rules semantics and operational table policy.
- ADR template and initial ADRs when code-facing choices are accepted.

Exit criteria:

- Every known rules decision axis is recorded.
- Decisions needed for the next milestone are selected with an explicit provisional or accepted status; later decisions may remain open with a required-by gate.
- No planned behavior relies on an undocumented default.
- Major technical risks have a mitigation and trigger.

## Milestone 0B — Repository and pure-domain contract

Status: complete

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
- One worked example covers setup, deal, bonus replacement, draw/discard, and wall exhaustion under the selected provisional foundational rules.

Evidence:

- Root checks run formatting, typed lint, strict source/test typechecks, import boundaries, package exports, and tests.
- Pure package source typechecks without Node, DOM, React, Discord, Cloudflare, or Workers ambient types.
- `game-core` tests cover opaque identities, physical tile IDs, seat order, JSON-safe persistence, snapshot decoding, and event-tail replay.
- `rules-hong-kong` tests cover strict profile validation, canonical 144-tile inventory, stable boundary IDs, and the 53-tile initial deal.
- The worked lifecycle and rule-to-test traceability are documented under `docs/rules/hong-kong-v1`.

## Milestone 1 — Deployed walking skeleton

Status: in progress — implementation and local evidence complete; Discord-proxied deployment evidence pending

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

Local evidence:

- `apps/discord-activity` builds the React SPA and Worker as one Cloudflare Vite deployment with static-asset fallback and `/api/*` Worker-first routing.
- Strict runtime configuration selects either the real Embedded App SDK bridge or the standalone mock bridge.
- The Worker implements health, mock authentication, Discord OAuth code exchange, signed application sessions, exact-origin request policy, and authenticated table WebSocket routing.
- The session boundary is recorded in ADR 0009. Production configuration fails closed on mock keys, invalid cookie settings, undersized current/previous keys, or a missing `__Host-` cookie prefix.
- `TableRoom` uses hibernatable WebSockets and bounded serialized attachments. A Workers-runtime integration test creates a session through the public Worker route, upgrades the socket, receives a viewer-safe snapshot, forces Durable Object eviction, and resynchronizes the same connection.
- The automated suite passes 64 domain tests, 17 client tests, and 16 Worker/Durable Object tests. CI also builds a Discord-mode production bundle.
- The documented standalone workflow and a live local HTTP check validate the mock session path without credentials.

Completion evidence still required:

- Deploy to a real Cloudflare/Discord Activity origin with protected Discord and signing credentials.
- Verify OAuth plus `discordSdk.commands.authenticate`, the partitioned application cookie, exact proxy `Origin`, and WebSocket upgrade through Discord's proxy.
- Record smoke evidence for Discord desktop/web and at least one mobile client. These external checks are intentionally not inferred from the local runtime tests.

## Milestone 2 — Identity, table access, and instance binding

Status: complete

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

Evidence:

- Discord authentication resolves `/users/@me`, verifies the exact application and Activity instance through the bot-authenticated Activity Instance API, and requires the trusted actor ID in its current `users` list before issuing a session.
- Signed session payload v2 is scoped to the verified instance and a server-side actor generation. Replacement and logout invalidate older HTTP and WebSocket authority; current/previous HMAC keys retain bounded rotation support.
- The SQLite-backed `ActivityInstance` persists one unpredictable table binding per instance. `TableRoom` owns the table ACL, immutable owner, actor-bound invitations, owner-only resume capabilities, binding receipts, session generations, and connection grants.
- Runtime tests prove same-instance convergence, different-instance separation, duplicate-session replacement, actor-bound invitation redemption, owner-only rebinding, old-instance rejection, forced-eviction recovery, and rejection of browser-selected table locators.
- Binding operation receipts and table-owned operation IDs make create/resume replay safe when either side loses a response before finalizing the cross-object saga.
- The local quality gate passes 64 domain tests, 29 client tests, and 79 Worker/Durable Object tests. The production-style Worker and client bundle also builds locally with CI intentionally disabled.

## Milestone 3 — Persistent lobby and viewer-safe protocol

Status: complete

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

Evidence:

- `TableRoom` storage schema v2 transactionally migrates the committed Milestone 2 schema while preserving table ownership, ACL members, binding receipts, capabilities, actor sessions, and connection grants. Unknown future schema versions fail closed.
- SQLite owns the room revision, four exclusive actor-reserved seats, ready state, and actor-scoped command receipts. Membership and accepted lobby mutations increment the viewer-visible revision exactly once; reconnect and socket closure do not release a seat.
- Protocol-v1 command envelopes are runtime validated. Identical same-actor retries replay the stored receipt, changed or cross-actor command-ID reuse returns a generic collision, and stale commands receive a rejection followed by a current viewer-specific snapshot.
- Every snapshot is independently projected from allowlisted lobby fields for its authenticated viewer. Strict client decoding rejects extra canonical/hidden fields, malformed seat topology, duplicate identities, and inconsistent viewer roles.
- Runtime tests fill all four distinct seats while a fifth member remains a spectator, persist ready reservations through reconnect and forced eviction, exercise command replay/collision/stale behavior, load a persisted v1 schema fixture, reject an unknown schema, and drive a lobby command through the public Worker WebSocket route before eviction/resync.
- The React client renders the four seats and spectators and exposes claim, move, leave, and ready controls using the current snapshot revision. Rejected receipts and connection state are surfaced accessibly. A local browser smoke test exercised claim/readiness at desktop and mobile widths without console errors or horizontal overflow.
- The local quality gate passes 64 domain tests, 40 client tests, and 85 Worker/Durable Object tests. The production-style Worker and client bundle also builds locally with CI intentionally disabled.

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

Re-check these claims against primary documentation at each platform milestone because platform behavior and package APIs can change.
