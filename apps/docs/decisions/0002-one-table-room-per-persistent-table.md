# ADR 0002: One TableRoom per persistent table

Status: accepted

Date: 2026-08-23

## Context

A Mahjong table needs serial command ordering, hidden authoritative state, persistence, deadlines, and connected-client coordination.

## Decision

Give each persistent table one `TableRoom` Durable Object with a private SQLite database. It owns room coordination and composes the pure rules aggregate, while keeping room and game state conceptually separate.

## Consequences

Commands for one table are naturally serialized and transactionally stored. Tables scale across objects, but cross-table queries require a separate design and object storage is not a conventional shared database.
