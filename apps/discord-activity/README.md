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
presence. They survive disconnect, hibernation, and Durable Object eviction
until the player explicitly leaves. WebSocket attachments retain only bounded
connection/session identity; room/game authority, deadlines, revisions, and
receipts remain in SQLite.

Schema v4 retains the permanent migration roots
`tests/fixtures/table-room-v1-schema.ts` and
`tests/fixtures/table-room-v3-active-v1-game.ts`. The latter verifies its
historical v1 hash chain, appends one explicit state-upgrade event, and
continues play as canonical state v2.

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
v4 remains forward-only across a code rollback; use the previous release only
if it understands schema v4, otherwise restore the complete pre-migration
deployment and storage backup rather than attempting to reinterpret v4 rows.

The production command fails before building unless `VITE_ACTIVITY_MODE=discord` and a valid `VITE_DISCORD_CLIENT_ID` are present. The production Wrangler environment does not inherit the committed mock signing key.

Provision Worker secrets before the first deployment:

```text
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put DISCORD_CLIENT_ID --env production
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put DISCORD_CLIENT_SECRET --env production
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put DISCORD_BOT_TOKEN --env production
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put SESSION_SIGNING_KEY --env production
```

Only provision `SESSION_SIGNING_KEY_PREVIOUS` during an active signing-key rotation. Then run `corepack pnpm --filter @mahjong/discord-activity deploy`. Deployment is intentionally manual and credential-gated; local implementation and tests never invoke it.
