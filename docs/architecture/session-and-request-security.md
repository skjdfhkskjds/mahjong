# Session and request security

Last reviewed: 2026-08-23

This is the Milestone 1 walking-skeleton contract. It deliberately separates Discord SDK authentication from Mahjong application authorization.

## Discord startup

1. Construct the Embedded App SDK and retain its `instanceId` as untrusted context.
2. Await SDK readiness.
3. Request an authorization code with the minimum `identify` scope.
4. POST the code and contextual instance ID to the Worker.
5. The Worker exchanges the code and resolves the Discord user.
6. The Worker issues the short-lived signed application cookie and returns the Discord access token once.
7. The client immediately calls `discordSdk.commands.authenticate({ access_token })` and retains neither token in persistent browser storage.

Activity Instance membership verification and table authorization are added in Milestone 2. Until then, no client-provided instance ID grants access to a persistent table.

## Session payload

```text
version
mode: mock | discord
actorId
displayName
issuedAt
expiresAt
csrfToken
```

The payload is canonical JSON encoded with base64url and authenticated using HMAC-SHA-256. Decoding rejects malformed encodings, unsupported versions/modes, missing fields, invalid timestamps, bad signatures, and expired sessions. Signature comparison is constant-time. The current key signs; a previous key may verify during rotation.

No OAuth access token, refresh token, Discord client secret, bot token, wall data, game state, or arbitrary request payload belongs in this credential.

## HTTP policy

- Safe session/health reads do not mutate state.
- Mutations accept only their documented media type and bounded runtime-validated body.
- Authenticated mutations require the session's CSRF token in a request header.
- Mutations reject missing or non-matching `Origin`; the accepted origin is the request's own externally visible origin.
- Responses do not enable permissive CORS.
- Authentication failures use generic error codes and never reveal cookie or signature details.

## WebSocket policy

The Worker authenticates and checks exact origin before forwarding an upgrade to `TableRoom`. The object serializes a small attachment containing connection ID, actor ID, session expiry, and connection generation. It does not treat the attachment as table membership or gameplay authority.

Every message validates the attachment shape and expiry because a message may wake a newly constructed object. Invalid or expired connections close without processing. Authoritative state survives only in SQLite; connection attachments survive only while their sockets remain alive.

## Mock-mode boundary

Mock mode is a local-development adapter, not an identity provider. The server chooses the actor identifier and exposes no route that can create a mock session when configured for Discord mode. Production configuration validation rejects missing Discord and signing secrets before a Discord authentication request is processed.
