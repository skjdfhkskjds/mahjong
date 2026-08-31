# ADR 0010: Keep table access separate from Activity instance binding

Status: accepted

Date: 2026-08-23

## Context

Discord Activity instances are temporary launch contexts. A persistent Mahjong table can outlive one instance, and a browser-provided instance or table identifier is not authorization. `ActivityInstance` and `TableRoom` Durable Objects also cannot share a transaction, so a partially completed binding must be recoverable without creating two tables or granting stale access.

The application needs a concrete creation, membership, invitation, resume, duplicate-session, and replacement policy before lobby state is persisted.

## Decision

The Worker exchanges the Discord authorization code, resolves the user through `/users/@me`, and then verifies the supplied instance through Discord's bot-authenticated Activity Instance API. The response must identify the configured application and exact instance and must list the resolved user. The bot token is a server-only REST credential; the product has no bot commands, Gateway process, or companion-bot interface.

The first verified actor resolving an unbound Activity instance creates its table and becomes the immutable table owner. Table IDs contain 128 random bits and are routing locators only. A bound instance lets a user discover the table, but `TableRoom` membership remains a separate authorization check.

Only the owner may create a 15-minute invitation for a named actor. The invitation is actor-bound and single-use. Redeeming it adds that actor to the table ACL but does not assign a seat. Only the owner may create a 15-minute resume capability. Redeeming it during authentication from a different verified instance atomically rebinds the existing table and increments its binding generation. The old instance and its connection grants then fail table authorization. Capability records, binding receipts, and pending binding state store a SHA-256 digest of the secret, never the bearer secret itself.

`ActivityInstance` persists one of these states:

```text
unbound -> binding(operationId, intent, tableId, deadline) -> bound(tableId, generation, proof)
```

It writes `binding` before calling `TableRoom`. The table records the operation input and result as an idempotent receipt. Repeating the same operation returns the same binding proof; reusing an operation ID for different input fails. If the table commit succeeds but its response or the `ActivityInstance` final write is lost, the next session resolution repeats the operation and completes `bound`. An operation that reaches the table after its deadline is rejected unless its receipt already proves that it committed.

Application session payload version 2 adds the verified instance ID, a random session ID, and a positive server-side generation. `ActivityInstance` stores only the session ID digest. A successful newer authentication replaces the prior actor/instance session. Logout advances the generation before clearing the cookie. `TableRoom` persists the current actor generation for members and invitees, rejects stale HTTP mutations and connections, and closes a live older socket when a newer generation activates.

WebSocket attachments contain only bounded connection identity, actor identity, session expiry, and connection generation. Authoritative instance, table, binding, ACL, and session-generation data live in SQLite-backed `TableRoom` records and are rechecked for every message after wake.

## Consequences

Knowledge of an instance ID, table ID, binding generation, or expired capability cannot authorize a table connection. Different Activity instances create different tables unless an owner presents a valid resume capability. Rebinding deliberately supersedes the old instance; its next resolution creates a new table rather than silently retaking the resumed table.

Every authenticated request performs signed-cookie and server-generation validation. Discord membership is checked at authentication and refreshed before table capability mutations and WebSocket upgrades. An already-open socket is not continuously polled against Discord, but it remains bounded by the application-session expiry and is invalidated by logout, replacement, or rebinding.

Public session responses distinguish `member` from `join-required` and expose the owner/member role only after table authorization. A join-required client waits for an actor-bound invitation instead of retrying a socket it cannot open. Session-replacement and authorization WebSocket closes are terminal until the client authenticates again.

The minimal access schema is established before the Milestone 3 room/game schema. Later lobby migrations must preserve table ownership, members, binding receipts, capabilities, actor session generations, and connection grants.

## References

- [Discord multiplayer and Activity instances](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience)
- [Discord Application Activity Instance resource](https://docs.discord.com/developers/resources/application#get-application-activity-instance)
- [Cloudflare Durable Object rules and transactions](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
