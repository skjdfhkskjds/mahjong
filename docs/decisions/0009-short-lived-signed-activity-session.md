# ADR 0009: Use a short-lived signed Activity session

Status: accepted

Date: 2026-08-23

## Context

Discord authentication and application authorization are adjacent but different. The client needs the short-lived Discord OAuth access token to call `discordSdk.commands.authenticate`, while Mahjong HTTP and WebSocket requests need an application-controlled credential. The walking skeleton must work without introducing a global database or a third Durable Object solely for sessions.

## Decision

Milestone 1 uses a versioned, short-lived application session encoded as JSON and authenticated with HMAC-SHA-256. The Worker accepts a current signing key and may accept one previous key during rotation. The session contains only its version, authentication mode, trusted actor identity, issuance/expiry timestamps, and a random CSRF token.

The Discord OAuth access token is returned once to the authenticating client, used immediately for the Embedded App SDK authentication command, and kept only in browser memory. It is never placed in the application cookie, local storage, logs, WebSocket attachments, or Durable Object storage.

In Discord mode, the application cookie is host-only and uses:

```text
Secure; HttpOnly; SameSite=None; Partitioned; Path=/
```

Standalone mock mode uses a localhost-compatible cookie without weakening Discord-mode attributes. Mock authentication exists only when `APP_MODE=mock`, accepts an optional display name but no caller-selected actor ID, and is disabled in Discord mode.

State-changing HTTP requests require JSON where applicable, an exact same-origin `Origin`, and the CSRF value bound into the signed session. CORS is not enabled. WebSocket upgrades require the exact origin and application cookie; the Durable Object attachment stores only bounded connection identity, actor identity, expiry, and generation. Expiry is rechecked on every delivered WebSocket message after wake.

Milestone 1 initially shipped with expiry but no server-side revocation list. Milestone 2 adds the per-actor, per-instance session identifier and generation selected in [ADR 0010](0010-table-access-and-instance-binding.md) without changing the cookie's role as the browser credential.

## Consequences

The Milestone 1 walking skeleton could exercise iframe cookies, authenticated HTTP, and hibernation recovery without central session state. As of Milestone 2, `ActivityInstance` adds targeted session replacement and revocation while current/previous signing keys continue to support credential rotation. Activity Instance membership, bot-token authorization, and table ACL enforcement are now implemented by ADR 0010.
