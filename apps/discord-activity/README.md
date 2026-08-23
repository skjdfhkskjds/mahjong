# Discord Activity application

This application is the single deployable React client and Cloudflare Worker. The Worker serves the SPA, exposes the same-origin HTTP API, and routes authenticated WebSockets to a SQLite-backed `TableRoom` Durable Object.

## Boundaries

- `src/client` owns React, the Embedded App SDK adapter, browser transport, and presentation state.
- `src/worker` owns HTTP authentication, request policy, platform integrations, and Durable Objects.
- Client and Worker source may import pure packages through public exports but may not import one another.
- The walking skeleton carries viewer-safe mock lobby snapshots only. It does not create Mahjong game state.

## Standalone development

From the repository root:

```text
corepack pnpm app:dev
```

The committed Wrangler variables run the Worker in mock mode with a development-only signing key. Open the printed localhost URL. The client creates a server-assigned mock identity, receives the application session cookie, and connects to the walking-skeleton table socket. No Discord or Cloudflare credentials are required.

Optional browser configuration belongs in an ignored `.env.local` copied from `.env.example`.

## Discord-proxied development

1. Create a Discord application and enable Activities.
2. Put the public client ID in `.env.local` and set `VITE_ACTIVITY_MODE=discord`.
3. Copy `.dev.vars.example` to the ignored `.dev.vars` and provide the Discord client secret, bot token, and at least 32 random bytes for the current session signing key.
4. Change the non-secret `APP_MODE` Wrangler variable to `discord` for that environment and use `__Host-mahjong_session` as the cookie name.
5. Run `corepack pnpm app:dev`.
6. Expose the printed local origin with `cloudflared tunnel --url <local-origin>` and configure that HTTPS target in the Discord Developer Portal URL mapping.
7. Launch the Activity through Discord and verify SDK authentication, the partitioned cookie, and WebSocket behavior on desktop/web and mobile.

Never commit `.env.local`, `.dev.vars`, the client secret, bot token, or signing keys. The Discord bot credential is reserved for Activity Instance verification in Milestone 2; there is no Gateway process or companion-bot UX.

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

The production command fails before building unless `VITE_ACTIVITY_MODE=discord` and a valid `VITE_DISCORD_CLIENT_ID` are present. The production Wrangler environment does not inherit the committed mock signing key.

Provision Worker secrets before the first deployment:

```text
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put DISCORD_CLIENT_ID --env production
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put DISCORD_CLIENT_SECRET --env production
corepack pnpm --filter @mahjong/discord-activity exec wrangler secret put SESSION_SIGNING_KEY --env production
```

Only provision `SESSION_SIGNING_KEY_PREVIOUS` during an active signing-key rotation. Then run `corepack pnpm --filter @mahjong/discord-activity deploy`. Deployment is intentionally manual and credential-gated; local implementation and tests never invoke it.
