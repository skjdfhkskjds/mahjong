# ADR 0004: Server-authoritative, viewer-projected gameplay

Status: accepted

Date: 2026-08-23

## Context

Mahjong contains hidden hands and a hidden wall. Browser clients and arrival order cannot be trusted to preserve secrecy or decide canonical transitions.

## Decision

The `TableRoom` is authoritative for ordering, legality, hidden state, deadlines, scoring, and progression. It sends a separately constructed view for each player or spectator. Canonical states and domain events never cross the client boundary.

## Consequences

Clients may preview and audit but cannot commit gameplay. Projection privacy becomes a first-class test surface, and viewer-safe deltas must be distinct types if added after snapshot-first delivery.
