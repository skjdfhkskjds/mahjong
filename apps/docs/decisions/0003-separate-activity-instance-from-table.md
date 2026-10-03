# ADR 0003: Separate Activity instance from table identity

Status: accepted

Date: 2026-08-23

## Context

Discord `instanceId` identifies one live Activity launch and is not a durable match identifier.

## Decision

Use an `ActivityInstance` Durable Object to bind an ephemeral `instanceId` to a separate persistent `tableId`. Resuming through a new instance requires an authorized table join/rebind flow and an idempotent cross-object saga.

## Consequences

Matches can outlive a Discord launch. The project must design ownership, invitations, cross-device resume, dangling-binding repair, and retention rather than treating an instance ID as authorization.
