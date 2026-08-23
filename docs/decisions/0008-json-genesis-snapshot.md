# ADR 0008: JSON-safe genesis snapshot replay root

Status: accepted

Date: 2026-08-23

## Context

The rules engine needs a deterministic replay root. Treating creation as an unpersisted operation would make an event tail insufficient, while encoding every setup detail as genesis events adds complexity before gameplay events exist. Persisted JavaScript values also need protection from JSON corruption.

## Decision

The replay root is a runtime-validated genesis snapshot with format version 1 and event sequence zero. Canonical state, configuration, and later domain events are restricted to finite JSON-safe values. Stored events replay in sequence through `evolve`.

The generic decoder validates the envelope and JSON safety. Each rules package remains responsible for narrower runtime validation of its own state, configuration, and event payloads.

## Consequences

Recovery can load a snapshot and replay its ordered event tail without synthesizing setup events. Rich runtime objects require explicit encoding. Future compaction snapshots need a separate format that records the event sequence they cover rather than masquerading as genesis.
