# ADR 0005: Command/event/reducer rules engine

Status: accepted

Date: 2026-08-23

## Context

The game must be deterministic, replayable, independently testable, and isolated from runtime APIs.

## Decision

Model game decisions as pure command handling that emits domain events, deterministic event evolution, viewer projection, and invariant checking. Supply clock, identifiers, and randomness explicitly. Define a versioned genesis replay root before persistence.

## Consequences

Accepted histories can be replayed and audited. The design adds event/schema compatibility work and requires discipline around which concerns are domain events versus room or transport state.
